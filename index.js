import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Initialize Stripe
let stripe;
try {
  stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  console.log('Stripe initialized successfully');
} catch (error) {
  console.error('Error initializing Stripe:', error);
}

// Debug logging for environment variables
console.log('Environment check:', {
  stripeKeyExists: !!process.env.STRIPE_SECRET_KEY,
  stripeKeyPrefix: process.env.STRIPE_SECRET_KEY?.substring(0, 7),
  supabaseUrlExists: !!process.env.SUPABASE_URL,
  supabaseKeyExists: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
});

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Middleware
app.use(express.json({
  verify: function(req, res, buf) {
    if (req.originalUrl.startsWith('/webhook')) {
      req.rawBody = buf.toString();
    }
  }
}));
app.use(cors({
  origin: ['https://zesty-semifreddo-7c79e3.netlify.app', 'http://localhost:5173'], // Allow both Netlify and local development
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Stripe-Signature'],
  credentials: true
}));

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ status: 'ok' });
});

// Create checkout session endpoint
app.post('/create-checkout-session', async (req, res) => {
  try {
    console.log('Received checkout request:', {
      body: req.body,
      headers: req.headers,
    });

    const { eventId, userId, successUrl, cancelUrl } = req.body;

    if (!eventId || !userId || !successUrl || !cancelUrl) {
      console.error('Missing required fields:', { eventId, userId, successUrl, cancelUrl });
      return res.status(400).json({ error: 'Missing required fields' });
    }

    console.log('Fetching event details for:', eventId);
    // Get event details from Supabase
    const { data: event, error: eventError } = await supabase
      .from('events')
      .select('*')
      .eq('id', eventId)
      .single();

    if (eventError) {
      console.error('Error fetching event:', eventError);
      throw eventError;
    }
    if (!event) {
      console.error('Event not found:', eventId);
      throw new Error('Event not found');
    }

    console.log('Event details:', event);

    if (!event.price || event.price <= 0) {
      console.error('Invalid event price:', event.price);
      return res.status(400).json({ error: 'Invalid event price' });
    }

    console.log('Creating Stripe session for event:', {
      title: event.title,
      price: event.price,
      currency: 'usd'
    });

    try {
      // Create Stripe checkout session
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [
          {
            price_data: {
              currency: 'usd',
              product_data: {
                name: event.title,
                description: event.description || '',
              },
              unit_amount: Math.round(event.price * 100), // Convert to cents
            },
            quantity: 1,
          },
        ],
        mode: 'payment',
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: {
          eventId,
          userId,
        },
      });

      console.log('Stripe session created:', {
        sessionId: session.id,
        url: session.url
      });

      console.log('Creating registration record');
      // Get user email from Supabase auth admin API
      const { data: userData, error: userError } = await supabase.auth.admin.getUserById(userId);

      if (userError) {
        console.error('Error fetching user:', userError);
        throw userError;
      }

      if (!userData?.user?.email) {
        console.error('User email not found');
        throw new Error('User email not found');
      }

      // Create registration with pending status
      const { error: regError } = await supabase
        .from('event_registrations')
        .insert([{
          event_id: eventId,
          user_id: userId,
          email: userData.user.email,
          status: 'pending',
          payment_status: 'pending',
          payment_amount: event.price,
          payment_method: 'stripe',
          stripe_session_id: session.id,
          ticket_number: Math.floor(1000 + Math.random() * 9000).toString(),
          ticket_status: 'VALID'
        }]);

      if (regError) {
        console.error('Error creating registration:', regError);
        throw regError;
      }

      console.log('Registration created successfully');
      res.json({ url: session.url });
    } catch (stripeError) {
      console.error('Stripe session creation error:', {
        error: stripeError.message,
        type: stripeError.type,
        code: stripeError.code,
        decline_code: stripeError.decline_code,
        stack: stripeError.stack
      });
      throw stripeError;
    }
  } catch (error) {
    console.error('Checkout session error:', {
      error: error.message,
      type: error.type,
      code: error.code,
      decline_code: error.decline_code,
      stack: error.stack
    });
    res.status(500).json({ 
      error: error.message,
      type: error.type,
      code: error.code,
      details: error.stack
    });
  }
});

// Stripe webhook endpoint
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the checkout.session.completed event
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { eventId, userId } = session.metadata;

    try {
      // Update registration status
      const { error } = await supabase
        .from('event_registrations')
        .update({
          status: 'pending',  // Keep as pending for admin approval
          payment_status: 'completed',
          payment_method: 'stripe',
          stripe_payment_intent_id: session.payment_intent
        })
        .match({
          event_id: eventId,
          user_id: userId,
          stripe_session_id: session.id
        });

      if (error) {
        console.error('Error updating registration:', error);
        return res.status(400).json({ error: error.message });
      }

      console.log(`✅ Registration approved for event ${eventId} and user ${userId}`);
    } catch (error) {
      console.error('Error processing webhook:', error);
      return res.status(400).json({ error: error.message });
    }
  }

  res.json({ received: true });
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

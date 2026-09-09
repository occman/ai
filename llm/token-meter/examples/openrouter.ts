/**
 * Sample Usage: OpenRouter with Usage Tracking
 * This demonstrates how to use the generic token meter to automatically report
 * token usage to Stripe for billing purposes when routing requests through
 * OpenRouter. OpenRouter exposes an OpenAI-compatible API, so the standard
 * OpenAI SDK is used with a custom baseURL.
 */

import {config} from 'dotenv';
import {resolve} from 'path';
import OpenAI from 'openai';
import {createTokenMeter} from '..';

// Load .env from the examples folder
config({path: resolve(__dirname, '.env')});

// Load environment variables from .env file
const STRIPE_API_KEY = process.env.STRIPE_API_KEY!;
const STRIPE_CUSTOMER_ID = process.env.STRIPE_CUSTOMER_ID!;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY!;

// Initialize the OpenAI client pointed at OpenRouter
const openrouter = new OpenAI({
  apiKey: OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
});

// Create the token meter
const meter = createTokenMeter(STRIPE_API_KEY);

// Sample 1: Basic Chat Completion (non-streaming)
async function sampleBasicChatCompletion() {
  const response = await openrouter.chat.completions.create({
    model: 'anthropic/claude-sonnet-4',
    messages: [
      {role: 'user', content: 'Say "Hello, World!" and nothing else.'},
    ],
    max_tokens: 20,
  });

  // Meter the response - auto-detects OpenRouter and bills as anthropic/claude-sonnet-4
  meter.trackUsage(response, STRIPE_CUSTOMER_ID);

  console.log('Response:', response.choices[0]?.message?.content);
  console.log('Usage:', response.usage);
}

// Sample 2: Streaming Chat Completion
async function sampleStreamingChatCompletion() {
  const stream = await openrouter.chat.completions.create({
    model: 'openai/gpt-4o-mini',
    messages: [
      {role: 'user', content: 'Count from 1 to 5, one number per line.'},
    ],
    stream: true,
    stream_options: {include_usage: true}, // Usage arrives in the final chunk
    max_tokens: 50,
  });

  // Wrap the stream for metering - works the same as a native OpenAI stream
  const meteredStream = meter.trackUsageStreamOpenAI(stream, STRIPE_CUSTOMER_ID);

  let fullContent = '';

  for await (const chunk of meteredStream) {
    const content = chunk.choices[0]?.delta?.content || '';
    fullContent += content;
    process.stdout.write(content);
  }

  console.log('\n\nFull content:', fullContent);
}

// Sample 3: Model variant (the :variant suffix is stripped for billing)
async function sampleModelVariant() {
  const response = await openrouter.chat.completions.create({
    model: 'anthropic/claude-sonnet-4:thinking',
    messages: [{role: 'user', content: 'What is 17 * 23?'}],
    max_tokens: 200,
  });

  // Billed as anthropic/claude-sonnet-4
  meter.trackUsage(response, STRIPE_CUSTOMER_ID);

  console.log('Response:', response.choices[0]?.message?.content);
  console.log('Usage:', response.usage);
}

// Run all samples
async function runAllSamples() {
  console.log('Starting OpenRouter Usage Tracking Examples');
  console.log(
    'These examples show how to use the generic meter with OpenRouter and Stripe billing\n'
  );

  try {
    console.log('\n' + '='.repeat(80));
    console.log('Sample 1: Basic Chat Completion');
    console.log('='.repeat(80));
    await sampleBasicChatCompletion();

    console.log('\n' + '='.repeat(80));
    console.log('Sample 2: Streaming Chat Completion');
    console.log('='.repeat(80));
    await sampleStreamingChatCompletion();

    console.log('\n' + '='.repeat(80));
    console.log('Sample 3: Model Variant');
    console.log('='.repeat(80));
    await sampleModelVariant();

    console.log('\n' + '='.repeat(80));
    console.log('All examples completed successfully!');
    console.log('='.repeat(80));
  } catch (error) {
    console.error('\n❌ Sample failed:', error);
    throw error;
  }
}

// Run the samples
runAllSamples().catch(console.error);

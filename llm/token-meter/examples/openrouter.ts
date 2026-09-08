/**
 * Sample Usage: OpenRouter with Usage Tracking
 * OpenRouter is OpenAI-compatible, so the standard OpenAI SDK is used with
 * baseURL pointed at OpenRouter. The token meter detects OpenRouter responses
 * and bills them under the upstream vendor model (e.g. anthropic/claude-sonnet-4).
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

// Initialize the OpenAI client against OpenRouter
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

  // Track usage with the meter (billed as anthropic/claude-sonnet-4)
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
    max_tokens: 50,
  });

  // Wrap the stream for metering (usage arrives in the final chunk)
  const meteredStream = meter.trackUsageStreamOpenAI(stream, STRIPE_CUSTOMER_ID);

  let fullContent = '';
  for await (const chunk of meteredStream) {
    const content = chunk.choices[0]?.delta?.content || '';
    fullContent += content;
    process.stdout.write(content);
  }

  console.log('\n\nFull content:', fullContent);
}

// Sample 3: Routing across vendors with a single meter
async function sampleMultiVendor() {
  const models = [
    'anthropic/claude-sonnet-4',
    'openai/gpt-4o-mini',
    'google/gemini-2.5-flash',
  ];

  for (const model of models) {
    const response = await openrouter.chat.completions.create({
      model,
      messages: [{role: 'user', content: 'Reply with one word: ready?'}],
      max_tokens: 5,
    });

    meter.trackUsage(response, STRIPE_CUSTOMER_ID);

    console.log(`${model}:`, response.choices[0]?.message?.content);
  }
}

// Run all samples
async function runAllSamples() {
  console.log('Starting OpenRouter Usage Tracking Examples');
  console.log(
    'These examples show how to use the generic token meter with OpenRouter\n'
  );

  try {
    await sampleBasicChatCompletion();
    await sampleStreamingChatCompletion();
    await sampleMultiVendor();

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

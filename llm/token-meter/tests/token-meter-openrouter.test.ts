/**
 * Tests for TokenMeter - OpenRouter Provider
 *
 * OpenRouter responses are OpenAI-compatible (served via the `openai` SDK
 * pointed at https://openrouter.ai/api/v1) but carry `usage.cost`, a
 * `<vendor>/<model>[:variant]` slug and optional OpenRouter-specific metadata.
 */

import Stripe from 'stripe';
import {createTokenMeter} from '../token-meter';
import type {MeterConfig} from '../types';

// Mock Stripe
jest.mock('stripe');

describe('TokenMeter - OpenRouter Provider', () => {
  let mockMeterEventsCreate: jest.Mock;
  let config: MeterConfig;
  const TEST_API_KEY = 'sk_test_mock_key';

  beforeEach(() => {
    jest.clearAllMocks();
    mockMeterEventsCreate = jest.fn().mockResolvedValue({});

    // Mock the Stripe constructor
    (Stripe as unknown as jest.Mock).mockImplementation(() => ({
      v2: {
        billing: {
          meterEvents: {
            create: mockMeterEventsCreate,
          },
        },
      },
    }));

    config = {};
  });

  describe('Chat Completions - Non-streaming', () => {
    it('should track usage from basic chat completion', async () => {
      const meter = createTokenMeter(TEST_API_KEY, config);

      const response = {
        id: 'gen-1234567890',
        object: 'chat.completion',
        created: Date.now(),
        model: 'anthropic/claude-sonnet-4',
        provider: 'Anthropic',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'Hello, World!',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 15,
          completion_tokens: 8,
          total_tokens: 23,
          cost: 0.000165,
        },
      };

      meter.trackUsage(response as any, 'cus_123');

      // Wait for fire-and-forget logging to complete
      await new Promise(resolve => setImmediate(resolve));

      expect(mockMeterEventsCreate).toHaveBeenCalledTimes(2);
      expect(mockMeterEventsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          event_name: 'token-billing-tokens',
          payload: expect.objectContaining({
            stripe_customer_id: 'cus_123',
            value: '15',
            model: 'anthropic/claude-sonnet-4',
            token_type: 'input',
          }),
        })
      );
      expect(mockMeterEventsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            value: '8',
            model: 'anthropic/claude-sonnet-4',
            token_type: 'output',
          }),
        })
      );
    });

    it('should not double-count reasoning tokens', async () => {
      const meter = createTokenMeter(TEST_API_KEY, config);

      // OpenRouter's completion_tokens already includes reasoning tokens
      const response = {
        id: 'gen-reasoning',
        object: 'chat.completion',
        created: Date.now(),
        model: 'openai/o3-mini',
        provider: 'OpenAI',
        choices: [
          {
            index: 0,
            message: {role: 'assistant', content: 'The answer is 42.'},
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 40,
          completion_tokens: 300,
          total_tokens: 340,
          cost: 0.0015,
          completion_tokens_details: {
            reasoning_tokens: 250,
          },
        },
      };

      meter.trackUsage(response as any, 'cus_reasoning');

      await new Promise(resolve => setImmediate(resolve));

      expect(mockMeterEventsCreate).toHaveBeenCalledTimes(2);
      expect(mockMeterEventsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            value: '300',
            model: 'openai/o3-mini',
            token_type: 'output',
          }),
        })
      );
    });

    it('should track usage from completion with cached prompt tokens', async () => {
      const meter = createTokenMeter(TEST_API_KEY, config);

      const response = {
        id: 'gen-cached',
        object: 'chat.completion',
        created: Date.now(),
        model: 'anthropic/claude-3-5-sonnet-20241022',
        provider: 'Anthropic',
        choices: [
          {
            index: 0,
            message: {role: 'assistant', content: 'Cached response.'},
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 1200,
          completion_tokens: 30,
          total_tokens: 1230,
          cost: 0.002,
          prompt_tokens_details: {
            cached_tokens: 1000,
          },
        },
      };

      meter.trackUsage(response as any, 'cus_cached');

      await new Promise(resolve => setImmediate(resolve));

      expect(mockMeterEventsCreate).toHaveBeenCalledTimes(2);
      expect(mockMeterEventsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            value: '1200',
            model: 'anthropic/claude-3.5-sonnet',
            token_type: 'input',
          }),
        })
      );
    });

    it('should track usage from completion with tool calls', async () => {
      const meter = createTokenMeter(TEST_API_KEY, config);

      const response = {
        id: 'gen-tools',
        object: 'chat.completion',
        created: Date.now(),
        model: 'openai/gpt-4o-2024-11-20',
        provider: 'OpenAI',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_abc',
                  type: 'function',
                  function: {
                    name: 'get_weather',
                    arguments: '{"location": "San Francisco"}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 25,
          total_tokens: 125,
          cost: 0.0005,
        },
      };

      meter.trackUsage(response as any, 'cus_tools');

      await new Promise(resolve => setImmediate(resolve));

      expect(mockMeterEventsCreate).toHaveBeenCalledTimes(2);
      expect(mockMeterEventsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            value: '100',
            model: 'openai/gpt-4o',
            token_type: 'input',
          }),
        })
      );
    });

    it('should detect OpenRouter from openrouter_metadata when cost is absent', async () => {
      const meter = createTokenMeter(TEST_API_KEY, config);

      const response = {
        id: 'gen-metadata',
        object: 'chat.completion',
        created: Date.now(),
        model: 'google/gemini-2.5-flash',
        openrouter_metadata: {
          provider_name: 'Google',
        },
        choices: [
          {
            index: 0,
            message: {role: 'assistant', content: 'Hi'},
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 4,
          total_tokens: 14,
        },
      };

      meter.trackUsage(response as any, 'cus_metadata');

      await new Promise(resolve => setImmediate(resolve));

      expect(mockMeterEventsCreate).toHaveBeenCalledTimes(2);
      expect(mockMeterEventsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            value: '10',
            model: 'google/gemini-2.5-flash',
            token_type: 'input',
          }),
        })
      );
    });
  });

  describe('Model Naming', () => {
    const makeResponse = (model: string) => ({
      id: 'gen-naming',
      object: 'chat.completion',
      created: Date.now(),
      model,
      provider: 'Upstream',
      choices: [
        {
          index: 0,
          message: {role: 'assistant', content: 'ok'},
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        cost: 0.0001,
      },
    });

    it('should strip :variant suffixes from the slug', async () => {
      const meter = createTokenMeter(TEST_API_KEY, config);

      meter.trackUsage(makeResponse('anthropic/claude-sonnet-4:thinking') as any, 'cus_123');
      await new Promise(resolve => setImmediate(resolve));

      expect(mockMeterEventsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            model: 'anthropic/claude-sonnet-4',
            token_type: 'input',
          }),
        })
      );

      mockMeterEventsCreate.mockClear();
      meter.trackUsage(makeResponse('meta-llama/llama-3.3-70b-instruct:free') as any, 'cus_123');
      await new Promise(resolve => setImmediate(resolve));

      expect(mockMeterEventsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            model: 'meta-llama/llama-3.3-70b-instruct',
            token_type: 'input',
          }),
        })
      );
    });

    it('should apply vendor normalization rules to anthropic slugs', async () => {
      const meter = createTokenMeter(TEST_API_KEY, config);

      meter.trackUsage(makeResponse('anthropic/claude-3-5-sonnet-20241022') as any, 'cus_123');
      await new Promise(resolve => setImmediate(resolve));

      expect(mockMeterEventsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            model: 'anthropic/claude-3.5-sonnet',
          }),
        })
      );
    });

    it('should apply vendor normalization rules to openai slugs', async () => {
      const meter = createTokenMeter(TEST_API_KEY, config);

      meter.trackUsage(makeResponse('openai/gpt-4o-2024-11-20') as any, 'cus_123');
      await new Promise(resolve => setImmediate(resolve));

      expect(mockMeterEventsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            model: 'openai/gpt-4o',
          }),
        })
      );
    });

    it('should pass google slugs through unchanged', async () => {
      const meter = createTokenMeter(TEST_API_KEY, config);

      meter.trackUsage(makeResponse('google/gemini-2.5-pro') as any, 'cus_123');
      await new Promise(resolve => setImmediate(resolve));

      expect(mockMeterEventsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            model: 'google/gemini-2.5-pro',
          }),
        })
      );
    });

    it('should fall back to openrouter/<model> for slugs without a vendor', async () => {
      const meter = createTokenMeter(TEST_API_KEY, config);

      meter.trackUsage(makeResponse('auto') as any, 'cus_123');
      await new Promise(resolve => setImmediate(resolve));

      expect(mockMeterEventsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            model: 'openrouter/auto',
          }),
        })
      );
    });
  });

  describe('Chat Completions - Streaming', () => {
    it('should track usage from streaming completion with usage in final chunk', async () => {
      const meter = createTokenMeter(TEST_API_KEY, config);

      const chunks = [
        {
          id: 'gen-stream',
          object: 'chat.completion.chunk',
          created: Date.now(),
          model: 'anthropic/claude-sonnet-4',
          provider: 'Anthropic',
          choices: [{index: 0, delta: {role: 'assistant', content: ''}, finish_reason: null}],
        },
        {
          id: 'gen-stream',
          object: 'chat.completion.chunk',
          created: Date.now(),
          model: 'anthropic/claude-sonnet-4',
          provider: 'Anthropic',
          choices: [{index: 0, delta: {content: 'Hello'}, finish_reason: null}],
        },
        {
          id: 'gen-stream',
          object: 'chat.completion.chunk',
          created: Date.now(),
          model: 'anthropic/claude-sonnet-4',
          provider: 'Anthropic',
          choices: [{index: 0, delta: {content: ', World!'}, finish_reason: 'stop'}],
        },
        {
          id: 'gen-stream',
          object: 'chat.completion.chunk',
          created: Date.now(),
          model: 'anthropic/claude-sonnet-4',
          provider: 'Anthropic',
          choices: [],
          usage: {
            prompt_tokens: 20,
            completion_tokens: 12,
            total_tokens: 32,
            cost: 0.00024,
          },
        },
      ];

      const mockStream = createMockStreamWithTee(chunks);
      const wrappedStream = meter.trackUsageStreamOpenAI(mockStream as any, 'cus_stream');

      const received: any[] = [];
      for await (const chunk of wrappedStream) {
        received.push(chunk);
      }

      // Wait for fire-and-forget logging to complete
      await new Promise(resolve => setImmediate(resolve));

      expect(received).toHaveLength(4);
      expect(mockMeterEventsCreate).toHaveBeenCalledTimes(2);
      expect(mockMeterEventsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            stripe_customer_id: 'cus_stream',
            value: '20',
            model: 'anthropic/claude-sonnet-4',
            token_type: 'input',
          }),
        })
      );
      expect(mockMeterEventsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            value: '12',
            model: 'anthropic/claude-sonnet-4',
            token_type: 'output',
          }),
        })
      );
    });

    it('should strip :variant suffixes from streamed slugs', async () => {
      const meter = createTokenMeter(TEST_API_KEY, config);

      const chunks = [
        {
          id: 'gen-stream-variant',
          object: 'chat.completion.chunk',
          model: 'openai/gpt-4o-mini:nitro',
          choices: [{index: 0, delta: {content: 'Hi'}, finish_reason: 'stop'}],
        },
        {
          id: 'gen-stream-variant',
          object: 'chat.completion.chunk',
          model: 'openai/gpt-4o-mini:nitro',
          choices: [],
          usage: {prompt_tokens: 5, completion_tokens: 2, total_tokens: 7, cost: 0.00001},
        },
      ];

      const mockStream = createMockStreamWithTee(chunks);
      const wrappedStream = meter.trackUsageStreamOpenAI(mockStream as any, 'cus_123');

      for await (const _chunk of wrappedStream) {
        // Consume stream
      }

      await new Promise(resolve => setImmediate(resolve));

      expect(mockMeterEventsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            model: 'openai/gpt-4o-mini',
            token_type: 'input',
          }),
        })
      );
    });
  });

  describe('Regression - provider attribution', () => {
    it('should not attribute an OpenRouter completion to openai', async () => {
      const meter = createTokenMeter(TEST_API_KEY, config);

      const response = {
        id: 'gen-regression',
        object: 'chat.completion',
        created: Date.now(),
        model: 'anthropic/claude-sonnet-4',
        choices: [
          {
            index: 0,
            message: {role: 'assistant', content: 'Hi'},
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 15,
          completion_tokens: 8,
          total_tokens: 23,
          cost: 0.000165,
        },
      };

      meter.trackUsage(response as any, 'cus_123');

      await new Promise(resolve => setImmediate(resolve));

      expect(mockMeterEventsCreate).toHaveBeenCalledTimes(2);
      for (const call of mockMeterEventsCreate.mock.calls) {
        expect(call[0].payload.model).toBe('anthropic/claude-sonnet-4');
        expect(call[0].payload.model).not.toMatch(/^openai\//);
      }
    });

    it('should still attribute a plain OpenAI completion to openai', async () => {
      const meter = createTokenMeter(TEST_API_KEY, config);

      const response = {
        id: 'chatcmpl-plain',
        object: 'chat.completion',
        created: Date.now(),
        model: 'gpt-4o-mini',
        choices: [
          {
            index: 0,
            message: {role: 'assistant', content: 'Hi'},
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 5,
          total_tokens: 17,
        },
      };

      meter.trackUsage(response as any, 'cus_123');

      await new Promise(resolve => setImmediate(resolve));

      expect(mockMeterEventsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            model: 'openai/gpt-4o-mini',
          }),
        })
      );
    });
  });
});

// Helper function to create mock streams with tee()
function createMockStreamWithTee(chunks: any[]) {
  return {
    tee() {
      const stream1 = {
        async *[Symbol.asyncIterator]() {
          for (const chunk of chunks) {
            yield chunk;
          }
        },
        tee() {
          const s1 = {
            async *[Symbol.asyncIterator]() {
              for (const chunk of chunks) {
                yield chunk;
              }
            },
          };
          const s2 = {
            async *[Symbol.asyncIterator]() {
              for (const chunk of chunks) {
                yield chunk;
              }
            },
          };
          return [s1, s2];
        },
      };
      const stream2 = {
        async *[Symbol.asyncIterator]() {
          for (const chunk of chunks) {
            yield chunk;
          }
        },
      };
      return [stream1, stream2];
    },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

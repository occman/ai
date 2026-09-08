/**
 * Tests for TokenMeter - OpenRouter Provider
 *
 * OpenRouter responses are OpenAI-compatible chat completions produced by the
 * OpenAI SDK pointed at https://openrouter.ai/api/v1. They carry a
 * `<vendor>/<model>[:variant]` slug in `model` and OpenRouter-only usage
 * accounting fields such as `usage.cost`.
 */

import Stripe from 'stripe';
import {createTokenMeter} from '../token-meter';
import {detectResponse} from '../utils/type-detection';
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
        id: 'gen-1234567890-abcdef',
        object: 'chat.completion',
        created: 1677652288,
        provider: 'Anthropic',
        model: 'anthropic/claude-sonnet-4',
        choices: [
          {
            index: 0,
            message: {role: 'assistant', content: 'Hello, World!'},
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

      const response = {
        id: 'gen-reasoning',
        object: 'chat.completion',
        created: 1677652288,
        provider: 'OpenAI',
        model: 'openai/o3-mini',
        choices: [
          {
            index: 0,
            message: {role: 'assistant', content: 'The answer is 42.'},
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 40,
          // completion_tokens already includes the reasoning tokens
          completion_tokens: 120,
          completion_tokens_details: {reasoning_tokens: 100},
          total_tokens: 160,
          cost: 0.00072,
        },
      };

      meter.trackUsage(response as any, 'cus_reasoning');

      // Wait for fire-and-forget logging to complete
      await new Promise(resolve => setImmediate(resolve));

      expect(mockMeterEventsCreate).toHaveBeenCalledTimes(2);
      expect(mockMeterEventsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            value: '120',
            model: 'openai/o3-mini',
            token_type: 'output',
          }),
        })
      );
    });

    it('should track usage with cached prompt tokens', async () => {
      const meter = createTokenMeter(TEST_API_KEY, config);

      const response = {
        id: 'gen-cached',
        object: 'chat.completion',
        created: 1677652288,
        provider: 'Anthropic',
        model: 'anthropic/claude-3-5-haiku-20241022',
        choices: [
          {
            index: 0,
            message: {role: 'assistant', content: 'Cached reply'},
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 500,
          prompt_tokens_details: {cached_tokens: 450},
          completion_tokens: 20,
          total_tokens: 520,
          cost: 0.0001,
        },
      };

      meter.trackUsage(response as any, 'cus_cached');

      // Wait for fire-and-forget logging to complete
      await new Promise(resolve => setImmediate(resolve));

      expect(mockMeterEventsCreate).toHaveBeenCalledTimes(2);
      expect(mockMeterEventsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            stripe_customer_id: 'cus_cached',
            value: '500',
            model: 'anthropic/claude-3.5-haiku',
            token_type: 'input',
          }),
        })
      );
    });

    it('should track usage from chat completion with tool calls', async () => {
      const meter = createTokenMeter(TEST_API_KEY, config);

      const response = {
        id: 'gen-tools',
        object: 'chat.completion',
        created: 1677652288,
        provider: 'Google',
        model: 'google/gemini-2.5-flash',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_123',
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
          completion_tokens: 45,
          total_tokens: 145,
          cost: 0.00005,
        },
      };

      meter.trackUsage(response as any, 'cus_tools');

      // Wait for fire-and-forget logging to complete
      await new Promise(resolve => setImmediate(resolve));

      expect(mockMeterEventsCreate).toHaveBeenCalledTimes(2);
      expect(mockMeterEventsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            value: '100',
            model: 'google/gemini-2.5-flash',
            token_type: 'input',
          }),
        })
      );
      expect(mockMeterEventsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            value: '45',
            model: 'google/gemini-2.5-flash',
            token_type: 'output',
          }),
        })
      );
    });

    it('should detect OpenRouter from openrouter_metadata without usage.cost', async () => {
      const meter = createTokenMeter(TEST_API_KEY, config);

      const response = {
        id: 'gen-metadata',
        object: 'chat.completion',
        created: 1677652288,
        model: 'anthropic/claude-sonnet-4',
        openrouter_metadata: {provider_name: 'Anthropic'},
        choices: [
          {
            index: 0,
            message: {role: 'assistant', content: 'Hi'},
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      };

      meter.trackUsage(response as any, 'cus_meta');

      // Wait for fire-and-forget logging to complete
      await new Promise(resolve => setImmediate(resolve));

      expect(mockMeterEventsCreate).toHaveBeenCalledTimes(2);
      expect(mockMeterEventsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            value: '10',
            model: 'anthropic/claude-sonnet-4',
            token_type: 'input',
          }),
        })
      );
    });
  });

  describe('Model Name Normalization', () => {
    const buildResponse = (model: string) => ({
      id: 'gen-model',
      object: 'chat.completion',
      created: 1677652288,
      provider: 'Upstream',
      model,
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
        cost: 0.00001,
      },
    });

    it('should strip :variant suffixes from the slug', async () => {
      const meter = createTokenMeter(TEST_API_KEY, config);

      meter.trackUsage(
        buildResponse('anthropic/claude-sonnet-4:thinking') as any,
        'cus_variant'
      );
      meter.trackUsage(
        buildResponse('meta-llama/llama-3.1-8b-instruct:free') as any,
        'cus_variant'
      );
      meter.trackUsage(
        buildResponse('openai/gpt-4o:nitro') as any,
        'cus_variant'
      );

      // Wait for fire-and-forget logging to complete
      await new Promise(resolve => setImmediate(resolve));

      const models = mockMeterEventsCreate.mock.calls
        .map(call => call[0].payload.model)
        .sort();
      expect(models).toEqual([
        'anthropic/claude-sonnet-4',
        'anthropic/claude-sonnet-4',
        'meta-llama/llama-3.1-8b-instruct',
        'meta-llama/llama-3.1-8b-instruct',
        'openai/gpt-4o',
        'openai/gpt-4o',
      ]);
    });

    it('should apply Anthropic normalization rules to anthropic/ slugs', async () => {
      const meter = createTokenMeter(TEST_API_KEY, config);

      meter.trackUsage(
        buildResponse('anthropic/claude-3-5-sonnet-20241022') as any,
        'cus_anthropic'
      );

      // Wait for fire-and-forget logging to complete
      await new Promise(resolve => setImmediate(resolve));

      expect(mockMeterEventsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            model: 'anthropic/claude-3.5-sonnet',
          }),
        })
      );
    });

    it('should apply OpenAI normalization rules to openai/ slugs', async () => {
      const meter = createTokenMeter(TEST_API_KEY, config);

      meter.trackUsage(
        buildResponse('openai/gpt-4o-2024-11-20') as any,
        'cus_openai'
      );

      // Wait for fire-and-forget logging to complete
      await new Promise(resolve => setImmediate(resolve));

      expect(mockMeterEventsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            model: 'openai/gpt-4o',
          }),
        })
      );
    });

    it('should keep google/ slugs as is', async () => {
      const meter = createTokenMeter(TEST_API_KEY, config);

      meter.trackUsage(
        buildResponse('google/gemini-2.5-pro') as any,
        'cus_google'
      );

      // Wait for fire-and-forget logging to complete
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

      meter.trackUsage(buildResponse('auto') as any, 'cus_auto');

      // Wait for fire-and-forget logging to complete
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
    it('should track usage from streaming chat completion via trackUsageStreamOpenAI', async () => {
      const meter = createTokenMeter(TEST_API_KEY, config);

      const chunks = [
        {
          id: 'gen-stream',
          object: 'chat.completion.chunk',
          created: 1677652288,
          provider: 'Anthropic',
          model: 'anthropic/claude-sonnet-4',
          choices: [
            {index: 0, delta: {role: 'assistant', content: ''}, finish_reason: null},
          ],
        },
        {
          id: 'gen-stream',
          object: 'chat.completion.chunk',
          created: 1677652288,
          provider: 'Anthropic',
          model: 'anthropic/claude-sonnet-4',
          choices: [{index: 0, delta: {content: 'Hello'}, finish_reason: null}],
        },
        {
          id: 'gen-stream',
          object: 'chat.completion.chunk',
          created: 1677652288,
          provider: 'Anthropic',
          model: 'anthropic/claude-sonnet-4',
          choices: [{index: 0, delta: {content: ', World!'}, finish_reason: 'stop'}],
        },
        // Final chunk: empty choices, carries usage
        {
          id: 'gen-stream',
          object: 'chat.completion.chunk',
          created: 1677652288,
          provider: 'Anthropic',
          model: 'anthropic/claude-sonnet-4',
          choices: [],
          usage: {
            prompt_tokens: 15,
            completion_tokens: 8,
            total_tokens: 23,
            cost: 0.000165,
          },
        },
      ];

      const mockStream = createMockStreamWithTee(chunks);
      const wrappedStream = meter.trackUsageStreamOpenAI(
        mockStream as any,
        'cus_stream'
      );

      const receivedChunks: any[] = [];
      for await (const chunk of wrappedStream) {
        receivedChunks.push(chunk);
      }

      // Wait for fire-and-forget logging to complete
      await new Promise(resolve => setImmediate(resolve));

      expect(receivedChunks).toHaveLength(4);
      expect(mockMeterEventsCreate).toHaveBeenCalledTimes(2);
      expect(mockMeterEventsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            stripe_customer_id: 'cus_stream',
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

    it('should detect OpenRouter when usage.cost only appears in the final chunk', async () => {
      const meter = createTokenMeter(TEST_API_KEY, config);

      const chunks = [
        {
          id: 'gen-stream-2',
          object: 'chat.completion.chunk',
          created: 1677652288,
          model: 'openai/gpt-4o-mini-2024-07-18:free',
          choices: [{index: 0, delta: {content: 'Hi'}, finish_reason: 'stop'}],
        },
        {
          id: 'gen-stream-2',
          object: 'chat.completion.chunk',
          created: 1677652288,
          model: 'openai/gpt-4o-mini-2024-07-18:free',
          choices: [],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 3,
            total_tokens: 15,
            cost: 0,
          },
        },
      ];

      const mockStream = createMockStreamWithTee(chunks);
      const wrappedStream = meter.trackUsageStreamOpenAI(
        mockStream as any,
        'cus_stream_2'
      );

      for await (const _chunk of wrappedStream) {
        // Consume stream
      }

      // Wait for fire-and-forget logging to complete
      await new Promise(resolve => setImmediate(resolve));

      expect(mockMeterEventsCreate).toHaveBeenCalledTimes(2);
      expect(mockMeterEventsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            value: '12',
            model: 'openai/gpt-4o-mini',
            token_type: 'input',
          }),
        })
      );
    });
  });

  describe('Provider Detection', () => {
    it('should detect an OpenRouter response as openrouter, not openai', () => {
      const response = {
        id: 'gen-detect',
        object: 'chat.completion',
        created: 1677652288,
        provider: 'Anthropic',
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

      const detected = detectResponse(response);

      expect(detected).not.toBeNull();
      expect(detected!.provider).toBe('openrouter');
      expect(detected!.provider).not.toBe('openai');
      expect(detected!.type).toBe('chat_completion');
      expect(detected!.model).toBe('anthropic/claude-sonnet-4');
      expect(detected!.inputTokens).toBe(15);
      expect(detected!.outputTokens).toBe(8);
    });

    it('should not misattribute an OpenRouter response to openai in meter events', async () => {
      const meter = createTokenMeter(TEST_API_KEY, config);

      const response = {
        id: 'gen-regression',
        object: 'chat.completion',
        created: 1677652288,
        provider: 'Anthropic',
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

      meter.trackUsage(response as any, 'cus_regression');

      // Wait for fire-and-forget logging to complete
      await new Promise(resolve => setImmediate(resolve));

      const models = mockMeterEventsCreate.mock.calls.map(
        call => call[0].payload.model
      );
      expect(models).toHaveLength(2);
      models.forEach(model => {
        expect(model).toBe('anthropic/claude-sonnet-4');
        expect(model).not.toBe('openai/anthropic/claude-sonnet-4');
        expect(model.startsWith('openai/')).toBe(false);
      });
    });

    it('should still detect a plain OpenAI chat completion as openai', () => {
      const response = {
        id: 'chatcmpl-plain',
        object: 'chat.completion',
        created: 1677652288,
        model: 'gpt-4o-mini',
        choices: [
          {
            index: 0,
            message: {role: 'assistant', content: 'Hi'},
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      };

      const detected = detectResponse(response);

      expect(detected!.provider).toBe('openai');
      expect(detected!.model).toBe('gpt-4o-mini');
    });

    it('should not treat a slash in the model name alone as an OpenRouter signal', () => {
      const response = {
        id: 'chatcmpl-gateway',
        object: 'chat.completion',
        created: 1677652288,
        model: 'some-vendor/some-model',
        choices: [
          {
            index: 0,
            message: {role: 'assistant', content: 'Hi'},
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      };

      const detected = detectResponse(response);

      expect(detected!.provider).toBe('openai');
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

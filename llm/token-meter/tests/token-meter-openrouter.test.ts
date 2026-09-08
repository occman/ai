/**
 * Tests for TokenMeter - OpenRouter Provider
 *
 * OpenRouter is OpenAI-compatible (used via the OpenAI SDK with
 * baseURL https://openrouter.ai/api/v1) but returns `<vendor>/<model>` slugs
 * and OpenRouter-specific usage fields such as `cost`.
 */

import Stripe from 'stripe';
import {createTokenMeter} from '../token-meter';
import {detectResponse} from '../utils/type-detection';
import type {MeterConfig} from '../types';

// Mock Stripe
jest.mock('stripe');

function openRouterCompletion(overrides: Record<string, unknown> = {}) {
  return {
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
          content: 'Hello from OpenRouter!',
        },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 25,
      total_tokens: 35,
      cost: 0.0012,
      cost_details: {
        upstream_inference_cost: null,
        upstream_inference_prompt_cost: 0.0008,
        upstream_inference_completions_cost: 0.0004,
      },
      prompt_tokens_details: {cached_tokens: 0},
      completion_tokens_details: {reasoning_tokens: 0},
    },
    ...overrides,
  };
}

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

  describe('Detection', () => {
    it('should detect an OpenRouter completion as openrouter, not openai', () => {
      const detected = detectResponse(openRouterCompletion());

      expect(detected).toEqual({
        provider: 'openrouter',
        type: 'chat_completion',
        model: 'anthropic/claude-sonnet-4',
        inputTokens: 10,
        outputTokens: 25,
      });
    });

    it('should detect OpenRouter from usage.cost alone', () => {
      const response = openRouterCompletion({provider: undefined});
      delete (response as any).provider;

      expect(detectResponse(response)?.provider).toBe('openrouter');
    });

    it('should detect OpenRouter from openrouter_metadata alone', () => {
      const response = openRouterCompletion({
        openrouter_metadata: {requested: 'anthropic/claude-sonnet-4'},
        usage: {prompt_tokens: 10, completion_tokens: 25, total_tokens: 35},
      });
      delete (response as any).provider;

      expect(detectResponse(response)?.provider).toBe('openrouter');
    });

    it('should still detect a plain OpenAI completion as openai', () => {
      const response = {
        id: 'chatcmpl-123',
        object: 'chat.completion',
        created: Date.now(),
        model: 'gpt-4o-mini',
        choices: [
          {index: 0, message: {role: 'assistant', content: 'Hi'}, finish_reason: 'stop'},
        ],
        usage: {prompt_tokens: 12, completion_tokens: 5, total_tokens: 17},
      };

      expect(detectResponse(response)?.provider).toBe('openai');
    });
  });

  describe('Chat Completions - Non-streaming', () => {
    it('should bill an OpenRouter completion under the upstream vendor model', async () => {
      const meter = createTokenMeter(TEST_API_KEY, config);

      meter.trackUsage(openRouterCompletion() as any, 'cus_123');

      // Wait for fire-and-forget logging to complete
      await new Promise(resolve => setImmediate(resolve));

      expect(mockMeterEventsCreate).toHaveBeenCalledTimes(2);
      expect(mockMeterEventsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          event_name: 'token-billing-tokens',
          payload: expect.objectContaining({
            stripe_customer_id: 'cus_123',
            value: '10',
            model: 'anthropic/claude-sonnet-4',
            token_type: 'input',
          }),
        })
      );
      expect(mockMeterEventsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            value: '25',
            model: 'anthropic/claude-sonnet-4',
            token_type: 'output',
          }),
        })
      );
    });

    it('should not prefix the model with openai/ (regression)', async () => {
      const meter = createTokenMeter(TEST_API_KEY, config);

      meter.trackUsage(openRouterCompletion() as any, 'cus_123');
      await new Promise(resolve => setImmediate(resolve));

      for (const [payload] of mockMeterEventsCreate.mock.calls) {
        expect(payload.payload.model).not.toMatch(/^openai\//);
        expect(payload.payload.model).not.toMatch(/^openrouter\//);
      }
    });

    it('should not double count reasoning tokens', async () => {
      const meter = createTokenMeter(TEST_API_KEY, config);

      const response = openRouterCompletion({
        model: 'openai/o3-mini',
        provider: 'OpenAI',
        usage: {
          prompt_tokens: 40,
          completion_tokens: 120,
          total_tokens: 160,
          cost: 0.003,
          completion_tokens_details: {reasoning_tokens: 80},
        },
      });

      meter.trackUsage(response as any, 'cus_123');
      await new Promise(resolve => setImmediate(resolve));

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

    it('should bill cached prompt tokens as part of input tokens', async () => {
      const meter = createTokenMeter(TEST_API_KEY, config);

      const response = openRouterCompletion({
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 20,
          total_tokens: 1020,
          cost: 0.0021,
          prompt_tokens_details: {cached_tokens: 900},
        },
      });

      meter.trackUsage(response as any, 'cus_123');
      await new Promise(resolve => setImmediate(resolve));

      expect(mockMeterEventsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            value: '1000',
            token_type: 'input',
          }),
        })
      );
    });

    it('should track usage from completion with tool calls', async () => {
      const meter = createTokenMeter(TEST_API_KEY, config);

      const response = openRouterCompletion({
        model: 'google/gemini-2.5-flash',
        provider: 'Google',
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
                    arguments: '{"location":"San Francisco"}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: {prompt_tokens: 100, completion_tokens: 30, total_tokens: 130, cost: 0.0001},
      });

      meter.trackUsage(response as any, 'cus_123');
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
    });

    it('should strip OpenRouter variant suffixes', async () => {
      const meter = createTokenMeter(TEST_API_KEY, config);

      const response = openRouterCompletion({
        model: 'anthropic/claude-3-5-sonnet-20241022:beta',
      });

      meter.trackUsage(response as any, 'cus_123');
      await new Promise(resolve => setImmediate(resolve));

      expect(mockMeterEventsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            model: 'anthropic/claude-3.5-sonnet',
          }),
        })
      );
    });

    it('should fall back to openrouter/<model> when the slug has no vendor', async () => {
      const meter = createTokenMeter(TEST_API_KEY, config);

      const response = openRouterCompletion({model: 'auto', provider: 'OpenRouter'});

      meter.trackUsage(response as any, 'cus_123');
      await new Promise(resolve => setImmediate(resolve));

      expect(mockMeterEventsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            model: 'openrouter/auto',
          }),
        })
      );
    });

    it('should not send events when usage is missing', async () => {
      const meter = createTokenMeter(TEST_API_KEY, config);

      const response = openRouterCompletion({usage: undefined, provider: 'Anthropic'});

      meter.trackUsage(response as any, 'cus_123');
      await new Promise(resolve => setImmediate(resolve));

      expect(mockMeterEventsCreate).not.toHaveBeenCalled();
    });
  });

  describe('Chat Completions - Streaming', () => {
    it('should track usage from an OpenRouter stream via trackUsageStreamOpenAI', async () => {
      const meter = createTokenMeter(TEST_API_KEY, config);

      const chunks = [
        {
          id: 'gen-123',
          object: 'chat.completion.chunk',
          created: Date.now(),
          model: 'anthropic/claude-sonnet-4',
          provider: 'Anthropic',
          choices: [{index: 0, delta: {role: 'assistant', content: 'Hello'}, finish_reason: null}],
        },
        {
          id: 'gen-123',
          object: 'chat.completion.chunk',
          created: Date.now(),
          model: 'anthropic/claude-sonnet-4',
          provider: 'Anthropic',
          choices: [{index: 0, delta: {content: ' world'}, finish_reason: 'stop'}],
        },
        {
          id: 'gen-123',
          object: 'chat.completion.chunk',
          created: Date.now(),
          model: 'anthropic/claude-sonnet-4',
          provider: 'Anthropic',
          choices: [],
          usage: {
            prompt_tokens: 15,
            completion_tokens: 8,
            total_tokens: 23,
            cost: 0.0005,
            prompt_tokens_details: {cached_tokens: 0},
            completion_tokens_details: {reasoning_tokens: 0},
          },
        },
      ];

      const mockStream = createMockStreamWithTee(chunks);
      const wrappedStream = meter.trackUsageStreamOpenAI(mockStream as any, 'cus_789');

      const receivedChunks: any[] = [];
      for await (const chunk of wrappedStream) {
        receivedChunks.push(chunk);
      }

      // Wait for fire-and-forget logging to complete
      await new Promise(resolve => setImmediate(resolve));

      expect(receivedChunks).toHaveLength(3);
      expect(mockMeterEventsCreate).toHaveBeenCalledTimes(2);
      expect(mockMeterEventsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            stripe_customer_id: 'cus_789',
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

    it('should detect OpenRouter when only the final usage chunk carries cost', async () => {
      const meter = createTokenMeter(TEST_API_KEY, config);

      const chunks = [
        {
          id: 'gen-456',
          object: 'chat.completion.chunk',
          created: Date.now(),
          model: 'openai/gpt-4o-2024-11-20',
          choices: [{index: 0, delta: {content: 'Hi'}, finish_reason: 'stop'}],
        },
        {
          id: 'gen-456',
          object: 'chat.completion.chunk',
          created: Date.now(),
          model: 'openai/gpt-4o-2024-11-20',
          choices: [],
          usage: {prompt_tokens: 5, completion_tokens: 1, total_tokens: 6, cost: 0.00002},
        },
      ];

      const mockStream = createMockStreamWithTee(chunks);
      const wrappedStream = meter.trackUsageStreamOpenAI(mockStream as any, 'cus_789');

      for await (const _chunk of wrappedStream) {
        // Consume stream
      }
      await new Promise(resolve => setImmediate(resolve));

      expect(mockMeterEventsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            model: 'openai/gpt-4o',
            token_type: 'input',
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

import {z} from 'zod';
import {createStripeAgentToolkit} from '@/modelcontextprotocol/toolkit';

type ToolHandler = (
  args: Record<string, unknown>,
  extra: unknown
) => Promise<{content: Array<{type: string; text: string}>}>;

interface RegisteredTool {
  shape: z.ZodRawShape;
  handler: ToolHandler;
}

const mockRegisteredTools = new Map<string, RegisteredTool>();
const mockRemoteCallTool = jest.fn();

jest.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {
    tool(
      name: string,
      _description: string,
      shape: z.ZodRawShape,
      handler: ToolHandler
    ): void {
      mockRegisteredTools.set(name, {shape, handler});
    }
  },
}));

jest.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    listTools: jest.fn().mockResolvedValue({
      tools: [
        {
          name: 'list_subscriptions',
          description: 'List subscriptions',
          inputSchema: {
            type: 'object',
            properties: {
              customer: {type: 'string'},
              limit: {type: 'number'},
            },
          },
        },
        {
          name: 'create_invoice',
          description: 'Create an invoice',
          inputSchema: {
            type: 'object',
            properties: {
              customer: {type: 'string'},
              days_until_due: {type: 'number'},
            },
            required: ['customer'],
          },
        },
      ],
    }),
    callTool: mockRemoteCallTool,
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: jest.fn().mockImplementation(() => ({})),
}));

describe('StripeAgentToolkit (modelcontextprotocol)', () => {
  beforeEach(() => {
    mockRegisteredTools.clear();
    mockRemoteCallTool.mockReset();
    mockRemoteCallTool.mockResolvedValue({
      content: [{type: 'text', text: '{"object": "list", "data": []}'}],
    });
  });

  const getRegisteredTool = (name: string): RegisteredTool => {
    const tool = mockRegisteredTools.get(name);
    if (!tool) {
      throw new Error(`Tool ${name} was not registered`);
    }
    return tool;
  };

  const callProxyTool = (name: string, args: Record<string, unknown>) => {
    const {shape, handler} = getRegisteredTool(name);
    const parsed = z.object(shape).safeParse(args);
    if (!parsed.success) {
      return Promise.reject(parsed.error);
    }
    return handler(args, {});
  };

  describe('customer scoping', () => {
    it('should always use the configured customer, even when args omit it', async () => {
      await createStripeAgentToolkit({
        secretKey: 'rk_test_123',
        configuration: {context: {customer: 'cus_configured'}},
      });

      const result = await callProxyTool('list_subscriptions', {limit: 3});

      expect(mockRemoteCallTool).toHaveBeenCalledWith({
        name: 'list_subscriptions',
        arguments: {limit: 3, customer: 'cus_configured'},
      });
      expect(result.content[0].text).toBe('{"object": "list", "data": []}');
    });

    it('should reject a client-supplied customer that differs from the configured one', async () => {
      await createStripeAgentToolkit({
        secretKey: 'rk_test_123',
        configuration: {context: {customer: 'cus_configured'}},
      });

      await expect(
        callProxyTool('list_subscriptions', {customer: 'cus_victim'})
      ).rejects.toThrow(
        "Customer context conflict: tool 'list_subscriptions' was called with customer 'cus_victim', but this toolkit is configured for customer 'cus_configured'"
      );

      expect(mockRemoteCallTool).not.toHaveBeenCalled();
    });

    it('should accept a client-supplied customer equal to the configured one', async () => {
      await createStripeAgentToolkit({
        secretKey: 'rk_test_123',
        configuration: {context: {customer: 'cus_configured'}},
      });

      await callProxyTool('list_subscriptions', {customer: 'cus_configured'});

      expect(mockRemoteCallTool).toHaveBeenCalledWith({
        name: 'list_subscriptions',
        arguments: {customer: 'cus_configured'},
      });
    });

    it('should supply the configured customer to tools that require it', async () => {
      await createStripeAgentToolkit({
        secretKey: 'rk_test_123',
        configuration: {context: {customer: 'cus_configured'}},
      });

      const {shape} = getRegisteredTool('create_invoice');
      expect(shape.customer.isOptional()).toBe(true);

      await callProxyTool('create_invoice', {days_until_due: 30});

      expect(mockRemoteCallTool).toHaveBeenCalledWith({
        name: 'create_invoice',
        arguments: {days_until_due: 30, customer: 'cus_configured'},
      });
    });

    it('should keep customer required when none is configured', async () => {
      await createStripeAgentToolkit({
        secretKey: 'rk_test_123',
        configuration: {},
      });

      const {shape} = getRegisteredTool('create_invoice');
      expect(shape.customer.isOptional()).toBe(false);

      await expect(
        callProxyTool('create_invoice', {days_until_due: 30})
      ).rejects.toBeInstanceOf(z.ZodError);
      expect(mockRemoteCallTool).not.toHaveBeenCalled();
    });

    it('should allow a client-supplied customer when none is configured', async () => {
      await createStripeAgentToolkit({
        secretKey: 'rk_test_123',
        configuration: {},
      });

      await callProxyTool('list_subscriptions', {customer: 'cus_from_args'});

      expect(mockRemoteCallTool).toHaveBeenCalledWith({
        name: 'list_subscriptions',
        arguments: {customer: 'cus_from_args'},
      });
    });
  });
});

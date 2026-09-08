import {createStripeAgentToolkit} from '@/modelcontextprotocol/toolkit';

type ToolHandler = (
  args: Record<string, unknown>,
  extra: unknown
) => Promise<{content: Array<{type: string; text: string}>}>;

const mockRegisteredTools = new Map<string, ToolHandler>();
const mockRemoteCallTool = jest.fn();

jest.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {
    tool(
      name: string,
      _description: string,
      _shape: unknown,
      handler: ToolHandler
    ): void {
      mockRegisteredTools.set(name, handler);
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

  const callProxyTool = (name: string, args: Record<string, unknown>) => {
    const handler = mockRegisteredTools.get(name);
    if (!handler) {
      throw new Error(`Tool ${name} was not registered`);
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

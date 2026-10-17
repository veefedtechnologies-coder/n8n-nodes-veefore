import {
  NodeConnectionTypes,
  NodeOperationError,
  sleep,
  type IDataObject,
  type IExecuteFunctions,
  type INodeExecutionData,
  type INodeType,
  type INodeTypeDescription,
} from 'n8n-workflow';
import {
  VeeforeGateway,
  VeeforeGatewayError,
  approvalReplayKey,
  itemIdempotencyKey,
  waitForApproval,
  type HttpFn,
  type VeeforeCredentials,
} from '../../lib/veefore';

/**
 * Veefore for n8n.
 *
 * "Execute action" sends the request to the Veefore gateway, which runs the
 * agent's capabilities, delegation, policy, risk and approval checks, leases
 * the provider credential from its broker and performs the call itself. The
 * workflow never holds the provider secret, and a refused action never
 * happened. "Authorize" asks for a decision without executing.
 *
 * Installing this node does not by itself protect anything: an n8n workflow
 * can still contain a direct Gmail or HTTP Request node. Veefore's workflow
 * verifier reports those paths, and the managed profile removes them.
 */

function credentialsFrom(data: IDataObject): VeeforeCredentials {
  return {
    gatewayUrl: String(data.gatewayUrl ?? ''),
    agentId: String(data.agentId ?? ''),
    keyId: String(data.keyId ?? ''),
    privateKey: String(data.privateKey ?? ''),
    runtimeConnectionId: data.runtimeConnectionId ? String(data.runtimeConnectionId) : undefined,
  };
}

/** Execution path: n8n's httpRequest helper, which honours the instance's proxy settings. */
function httpForExecute(helpers: IExecuteFunctions['helpers']): HttpFn {
  return async (request) => {
    const response = (await helpers.httpRequest({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: request.body as IDataObject | undefined,
      json: true,
      timeout: request.timeoutMs,
      returnFullResponse: true,
      ignoreHttpStatusErrors: true,
    })) as { statusCode: number; headers: Record<string, string>; body: unknown };
    return { status: response.statusCode, headers: response.headers, body: response.body };
  };
}

function parseParameters(
  node: IExecuteFunctions,
  raw: unknown,
  itemIndex: number,
): Record<string, unknown> {
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        return parsed as Record<string, unknown>;
    } catch {
      // Reported below with the item it came from.
    }
  }
  throw new NodeOperationError(node.getNode(), 'Parameters must be a JSON object.', { itemIndex });
}

export class Veefore implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Veefore',
    name: 'veefore',
    icon: { light: 'file:veefore.svg', dark: 'file:veefore.dark.svg' },
    group: ['transform'],
    version: 1,
    subtitle: '={{$parameter["operation"] + ": " + $parameter["tool"]}}',
    description: 'Run a protected action through Veefore policy, approval and credential brokering',
    defaults: { name: 'Veefore' },
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    usableAsTool: true,
    credentials: [{ name: 'veeforeApi', required: true }],
    properties: [
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        options: [
          {
            name: 'Execute Action',
            value: 'execute',
            action: 'Execute a protected action',
            description: 'Veefore decides, leases the credential and performs the call',
          },
          {
            name: 'Authorize',
            value: 'authorize',
            action: 'Ask whether an action would be allowed',
            description: 'Dry run: nothing executes',
          },
          {
            name: 'Get Approval Status',
            value: 'approvalStatus',
            action: 'Get the status of an approval',
          },
          {
            name: 'List Permitted Tools',
            value: 'listTools',
            action: 'List the tools this agent may attempt',
          },
        ],
        default: 'execute',
      },
      {
        displayName: 'Tool',
        name: 'tool',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'send_email',
        description: 'Key of a tool registered in Veefore',
        displayOptions: { show: { operation: ['execute', 'authorize'] } },
      },
      {
        displayName: 'Action',
        name: 'action',
        type: 'string',
        default: '',
        description: 'Logical action, when the tool has several. Defaults to the tool key.',
        displayOptions: { show: { operation: ['execute', 'authorize'] } },
      },
      {
        displayName: 'Parameters',
        name: 'parameters',
        type: 'json',
        default: '{}',
        description:
          'Arguments for the tool. Approval and authorization are bound to these exact values.',
        displayOptions: { show: { operation: ['execute', 'authorize'] } },
      },
      {
        displayName: 'Approval ID',
        name: 'approvalId',
        type: 'string',
        default: '',
        displayOptions: { show: { operation: ['approvalStatus'] } },
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        placeholder: 'Add Option',
        default: {},
        displayOptions: { show: { operation: ['execute', 'authorize'] } },
        options: [
          {
            displayName: 'Approval ID to Use',
            name: 'approvalId',
            type: 'string',
            default: '',
            description:
              'Run an action a person already approved. The parameters must match exactly.',
            displayOptions: { show: { '/operation': ['execute'] } },
          },
          {
            displayName: 'Authorization ID',
            name: 'authorizationId',
            type: 'string',
            default: '',
            description:
              'From an earlier "Authorize" for the same parameters. Single use, 120 seconds.',
            displayOptions: { show: { '/operation': ['execute'] } },
          },
          {
            displayName: 'Fail on Refusal',
            name: 'failOnRefusal',
            type: 'boolean',
            default: true,
            description:
              'Whether a refused or failed action stops the workflow. Off returns the decision as data.',
          },
          {
            displayName: 'Idempotency Key',
            name: 'idempotencyKey',
            type: 'string',
            default: '',
            description:
              'Defaults to instance, execution, step, item and arguments, so a retried step cannot act twice',
          },
          {
            displayName: 'Purpose',
            name: 'purpose',
            type: 'string',
            default: '',
            description: 'Why the action is being taken. Recorded and available to policy.',
          },
          {
            displayName: 'Wait for Approval (Seconds)',
            name: 'waitSeconds',
            type: 'number',
            typeOptions: { minValue: 0, maxValue: 3600 },
            default: 0,
            description:
              'When a person must approve, wait up to this long and then run the approved action. 0 returns "pending" straight away.',
            displayOptions: { show: { '/operation': ['execute'] } },
          },
        ],
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const credentials = credentialsFrom((await this.getCredentials('veeforeApi')) as IDataObject);
    const gateway = new VeeforeGateway(credentials, httpForExecute(this.helpers));
    const workflow = this.getWorkflow();
    const node = this.getNode();
    let instance: string | null = null;
    try {
      instance = this.getInstanceBaseUrl();
    } catch {
      instance = null;
    }
    let instanceId: string | null = null;
    try {
      instanceId = this.getInstanceId() || null;
    } catch {
      instanceId = null;
    }
    const runtime = {
      connectionId: credentials.runtimeConnectionId ?? null,
      instance,
      workflowId: workflow.id ? String(workflow.id) : null,
      executionId: this.getExecutionId() ?? null,
      step: node.name,
    };

    const out: INodeExecutionData[] = [];
    for (let itemIndex = 0; itemIndex < Math.max(items.length, 1); itemIndex += 1) {
      const operation = this.getNodeParameter('operation', itemIndex) as string;
      try {
        if (operation === 'listTools') {
          out.push({
            json: { tools: (await gateway.tools()) as unknown as IDataObject[] },
            pairedItem: { item: itemIndex },
          });
          continue;
        }
        if (operation === 'approvalStatus') {
          const approvalId = this.getNodeParameter('approvalId', itemIndex) as string;
          out.push({
            json: (await gateway.approvalStatus(approvalId)) as IDataObject,
            pairedItem: { item: itemIndex },
          });
          continue;
        }

        const tool = (this.getNodeParameter('tool', itemIndex) as string).trim();
        if (!tool)
          throw new NodeOperationError(node, 'Choose the Veefore tool to call.', { itemIndex });
        const action =
          (this.getNodeParameter('action', itemIndex, '') as string).trim() || undefined;
        const parameters = parseParameters(
          this,
          this.getNodeParameter('parameters', itemIndex, '{}'),
          itemIndex,
        );
        const options = this.getNodeParameter('options', itemIndex, {}) as IDataObject;
        const failOnRefusal = options.failOnRefusal !== false;
        const idempotencyKey = itemIdempotencyKey(
          {
            instanceId: instanceId ?? instance,
            workflowId: runtime.workflowId,
            executionId: runtime.executionId,
            node: node.name,
            itemIndex,
            tool,
            action,
            parameters,
          },
          options.idempotencyKey as string | undefined,
        );
        const base = {
          tool,
          action,
          parameters,
          purpose: (options.purpose as string | undefined) || undefined,
          idempotencyKey,
          runtime,
        };

        if (operation === 'authorize') {
          const decision = await gateway.authorize(base);
          if (failOnRefusal && decision.result !== 'ALLOW') {
            throw new NodeOperationError(
              node,
              `Veefore did not authorize this: ${String(decision.reason ?? decision.result)}`,
              { itemIndex },
            );
          }
          out.push({ json: decision as IDataObject, pairedItem: { item: itemIndex } });
          continue;
        }

        const presetApproval = (options.approvalId as string | undefined)?.trim() || undefined;
        let decision = await gateway.execute({
          ...base,
          approvalId: presetApproval,
          idempotencyKey: presetApproval
            ? approvalReplayKey(idempotencyKey, presetApproval)
            : idempotencyKey,
          authorizationId: (options.authorizationId as string | undefined)?.trim() || undefined,
        });

        const waitSeconds = Number(options.waitSeconds ?? 0);
        const approval = decision.approval as { approval_id?: string } | null | undefined;
        if (decision.outcome === 'APPROVAL_REQUIRED' && approval?.approval_id && waitSeconds > 0) {
          const status = await waitForApproval(gateway, approval.approval_id, waitSeconds, sleep);
          if (status === 'APPROVED') {
            decision = await gateway.execute({
              ...base,
              approvalId: approval.approval_id,
              idempotencyKey: approvalReplayKey(idempotencyKey, approval.approval_id),
            });
          } else {
            decision = { ...decision, approval_status: status };
          }
        }

        const allowed = decision.allowed === true;
        if (!allowed && failOnRefusal) {
          const pending = decision.outcome === 'APPROVAL_REQUIRED';
          throw new NodeOperationError(
            node,
            pending
              ? `Waiting for a person to approve (approval ${approval?.approval_id ?? 'unknown'}). Nothing has been done yet.`
              : decision.outcome === 'FAILED'
                ? `Veefore allowed this, but the tool did not complete: ${String(decision.reason)}. Do not assume it happened.`
                : `Veefore blocked this: ${String(decision.reason)}`,
            { itemIndex, description: `Action ${String(decision.action_id ?? '')}` },
          );
        }
        out.push({
          json: {
            allowed,
            decision: decision.decision,
            outcome: decision.outcome,
            reason: decision.reason,
            action_id: decision.action_id,
            approval: (decision.approval ?? null) as IDataObject | null,
            result: (decision.result ?? null) as IDataObject | null,
          } as IDataObject,
          pairedItem: { item: itemIndex },
        });
      } catch (error) {
        if (this.continueOnFail()) {
          out.push({ json: { error: (error as Error).message }, pairedItem: { item: itemIndex } });
          continue;
        }
        if (error instanceof VeeforeGatewayError) {
          throw new NodeOperationError(node, error.message, {
            itemIndex,
            description: error.code ?? undefined,
          });
        }
        throw new NodeOperationError(node, error as Error, { itemIndex });
      }
    }
    return [out];
  }
}

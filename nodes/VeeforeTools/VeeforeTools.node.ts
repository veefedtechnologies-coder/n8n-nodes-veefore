import {
  NodeConnectionTypes,
  type IDataObject,
  type IDisplayOptions,
  type IExecuteFunctions,
  type ILoadOptionsFunctions,
  type INodeExecutionData,
  type INodePropertyOptions,
  type INodeType,
  type INodeTypeDescription,
  type ISupplyDataFunctions,
  type ResourceMapperFields,
  type SupplyData,
} from 'n8n-workflow';
import {
  EDITOR_TOOLS_MAX_AGE_MS,
  itemIdempotencyKey,
  type VeeforeGateway,
} from '../../lib/veefore';
import type { GuardedNode, VeeforeToolEntry } from '../../lib/guard';
import {
  APP_CHECK_EXPRESSION,
  AUTO_PURPOSE,
  INPUTS_EXPRESSION,
  SUBTITLE_EXPRESSION,
  appConfigs,
  appFieldsFor,
  appOfEntry,
  appOfValue,
  appTools,
  appValue,
  groupApps,
  N8N_PERFORMS,
  TOOLS_MESSAGES,
  argumentsFor,
  fieldValue,
  keyOf,
  needsN8nTools,
  parametersFor,
  planTools,
  purposeFor,
  readAction,
  VEEFORE_PERFORMS,
  selectionValue,
  type ActionConfig,
  type ConnectedTool,
  type Plan,
  type PlanEntry,
  type RawAction,
} from '../../lib/agent-tools';
import { GUARD_MESSAGES } from '../../lib/guard';
import {
  canFollow,
  decideN8nCall,
  followApproval,
  originOf,
  reportClientResult,
  runVeeforeCall,
} from '../Veefore/calls';
import { gatewayFor } from '../Veefore/gateway';
import { fieldsFromSchema, labelFor, type JsonSchema } from '../Veefore/schema';

/**
 * Veefore Tools: an agent's Veefore actions for an AI Agent. Version 3 gives
 * one app per node (all its actions, or the ones picked, and the model picks
 * the one each request needs); version 2 one action per node; version 1 a list.
 *
 * For each action Veefore decides every call (policy, risk, approvals):
 *
 *  - an action Veefore performs is carried out by the gateway. Its parameters
 *    are set in the node: each one is filled by the model (with the hint the
 *    model is given) or fixed, so the model never sees it;
 *  - an action n8n performs is carried out by the n8n tool wired into this
 *    node's **n8n Tools** input (shown once such an action is added), and only
 *    after Veefore allows that exact call. Its fields are set in that tool.
 *
 * Tools wired in only reach the model through this node, and only for the
 * added actions n8n performs.
 *
 * n8n's AI Agent runs a call by executing this node with the tool's name and
 * arguments (`execute`); older agents call the tool directly (`supplyData`'s
 * `invoke`). Both go through `callTool`.
 */

type Context = ISupplyDataFunctions | IExecuteFunctions;

interface Prepared {
  plan: Plan;
  gateway: VeeforeGateway;
}

const ACTIONS = 'actions.action';

/**
 * Version 3, once an app is chosen. Its settings show only then, so they
 * load for that app: the editor does not reload a list when another setting
 * changes while any value is left to the model (✨).
 */
const V3_APP_CHOSEN: NonNullable<IDisplayOptions['show']> = {
  '@version': [{ _cnd: { gte: 3 } }],
  app: [
    { _cnd: { endsWith: '::veefore' } },
    { _cnd: { endsWith: '::n8n' } },
    { _cnd: { endsWith: '::mixed' } },
  ],
};

function sendWhenApprovedOf(context: Context, itemIndex: number): boolean {
  const options = context.getNodeParameter('options', itemIndex, {}) as IDataObject;
  return options.sendWhenApproved !== false;
}

function waitMsOf(context: Context, itemIndex: number): number {
  const options = context.getNodeParameter('options', itemIndex, {}) as IDataObject;
  const minutes = options.waitMinutes === undefined ? 2 : Number(options.waitMinutes);
  return Math.min(1440, Math.max(0, Number.isFinite(minutes) ? minutes : 2)) * 60_000;
}

/** The n8n tools wired into this node, toolkits flattened. */
async function connectedTools(context: Context, itemIndex: number): Promise<ConnectedTool[]> {
  let raw: unknown;
  try {
    raw = await context.getInputConnectionData(NodeConnectionTypes.AiTool, itemIndex);
  } catch {
    // No n8n Tools input (no action n8n performs), or nothing wired in.
    return [];
  }
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.flatMap((entry) => {
    const toolkit = entry as { tools?: unknown };
    return (Array.isArray(toolkit.tools) ? toolkit.tools : [entry]) as ConnectedTool[];
  });
}

/** The actions as set up in the node. `$fromAI` is read, not evaluated: the model fills it. */
function actionsOf(
  context: Context,
  itemIndex: number,
  available: VeeforeToolEntry[],
): { raw: RawAction[]; configs: ActionConfig[]; hints?: string[] } {
  const read = (name: string, fallback: unknown) =>
    context.getNodeParameter(name, itemIndex, fallback, { rawExpressions: true });
  const schemaOf = (item: RawAction) =>
    available.find((tool) => tool.key === keyOf(item.tool))?.parameter_schema as
      | JsonSchema
      | undefined;
  if (context.getNode().typeVersion >= 3) {
    // One app per node: its picked actions, with the app's Fields.
    const { raw, configs, hints } = appConfigs(
      {
        app: read('app', ''),
        actions: read('appActions', []),
        fields: read('appFields', null) as RawAction['parameters'],
        purpose: read('appPurpose', AUTO_PURPOSE),
      },
      available,
      (name) =>
        context.getNodeParameter(
          name === 'actions'
            ? 'appActions'
            : name === 'purpose'
              ? 'appPurpose'
              : name.replace(/^parameters\./, 'appFields.'),
          itemIndex,
        ),
    );
    return { raw, configs, hints };
  }
  if (context.getNode().typeVersion >= 2) {
    // One action per node, set at the top level.
    const options = (read('options', {}) ?? {}) as IDataObject;
    const item: RawAction = {
      tool: read('tool', ''),
      parameters: read('parameters', null) as RawAction['parameters'],
      purpose: read('purpose', ''),
      descriptionType: read('descriptionType', 'auto'),
      toolDescription: read('toolDescription', ''),
      actionOptions: { toolName: options.toolName },
    };
    const config = readAction(item, schemaOf(item), (name) =>
      context.getNodeParameter(name, itemIndex),
    );
    return { raw: [item], configs: [config] };
  }
  const raw = (read(ACTIONS, []) ?? []) as RawAction[];
  const configs = raw.map((item, index) =>
    readAction(item, schemaOf(item), (name) =>
      context.getNodeParameter(`${ACTIONS}[${index}].${name}`, itemIndex),
    ),
  );
  return { raw, configs };
}

async function prepare(context: Context, itemIndex: number): Promise<Prepared> {
  const node = context.getNode();
  const gateway = await gatewayFor(context);
  const available = (await gateway.tools()) as unknown as VeeforeToolEntry[];
  const { raw, configs, hints = [] } = actionsOf(context, itemIndex, available);
  const wired = needsN8nTools(raw) ? await connectedTools(context, itemIndex) : [];
  const nodes = wired.length
    ? (context.getParentNodes(node.name, {
        connectionType: NodeConnectionTypes.AiTool,
        depth: 1,
        includeNodeParameters: true,
      }) as GuardedNode[])
    : [];
  const plan = planTools(configs, available, wired, nodes, {
    offerMissing: node.typeVersion < 3,
  });
  plan.hints.unshift(...hints);
  return { plan, gateway };
}

function parsed(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/** One call from the model: Veefore decides, then the right side performs it. */
async function callTool(
  context: Context,
  prepared: Prepared,
  entry: PlanEntry,
  input: Record<string, unknown>,
  itemIndex: number,
  callId: string,
): Promise<IDataObject> {
  const node = context.getNode();
  const args = argumentsFor(entry, input);
  const waitMs = waitMsOf(context, itemIndex);
  const origin = originOf(context);
  const callKey = `${node.name}:${entry.name}:${callId}`;
  const label = entry.tool.name || entry.tool.key;

  if (entry.kind === 'missing') {
    return { status: 'refused', message: TOOLS_MESSAGES.notConnected(label) };
  }
  if (entry.kind === 'veefore') {
    const parameters = parametersFor(entry, args);
    const idempotencyKey = itemIdempotencyKey({
      instanceId: origin.instanceScope,
      workflowId: origin.runtime.workflowId,
      executionId: origin.runtime.executionId,
      node: callKey,
      itemIndex,
      tool: entry.tool.key,
      parameters,
    });
    return runVeeforeCall(
      prepared.gateway,
      {
        tool: entry.tool.key,
        parameters,
        purpose: purposeFor(entry, args),
        idempotencyKey,
        runtime: origin.runtime,
      },
      waitMs,
    );
  }
  const answer = await decideN8nCall(prepared.gateway, {
    // The added action, not any other one that happens to match the node.
    tools: [entry.tool],
    target: entry.node,
    toolParameters: args,
    waitMs,
    origin,
    callKey,
    itemIndex,
    purpose: entry.config.purpose,
  });
  if (!answer.approved) {
    let message = answer.chatInput ?? 'Veefore did not allow this. It was NOT done.';
    if (
      answer.pending &&
      sendWhenApprovedOf(context, itemIndex) &&
      canFollow(answer.pending.approvalId)
    ) {
      // The agent answers now; the call is made once a person approves it.
      // By then the run has ended and released n8n's expression engine, which
      // the tool needs to read its $fromAI fields: hold it again for the call.
      const connected = entry.connected;
      const expression = (
        context as unknown as {
          workflow?: { expression?: { withIsolate?: <T>(fn: () => Promise<T>) => Promise<T> } };
        }
      ).workflow?.expression;
      const perform = () =>
        typeof expression?.withIsolate === 'function'
          ? expression.withIsolate(() => connected.invoke(args))
          : connected.invoke(args);
      void followApproval(prepared.gateway, answer.pending, perform, {
        log: (text, meta) => context.logger?.info(`${text} (${node.name}: ${label})`, meta),
      });
      message = GUARD_MESSAGES.pendingFollowed(label, answer.pending.expiresAt);
    }
    return {
      status: String(answer.veefore.status ?? 'refused'),
      message,
      veefore: answer.veefore as IDataObject,
    };
  }
  const actionId = typeof answer.veefore.action_id === 'string' ? answer.veefore.action_id : null;
  const log = (text: string, meta?: Record<string, unknown>) =>
    context.logger?.warn(`${text} (${node.name}: ${label})`, meta);
  let result: unknown;
  try {
    result = await entry.connected.invoke(args);
  } catch (error) {
    // Allowed, but n8n could not do it: Veefore records the failure.
    await reportClientResult(
      prepared.gateway,
      actionId,
      'FAILED',
      (error as Error).message ?? 'The n8n tool failed.',
      log,
    );
    return {
      status: 'failed',
      message: `Veefore allowed "${label}", but the n8n tool failed: ${(error as Error).message ?? 'unknown error'}. It was NOT done. Tell the user it failed.`,
      veefore: answer.veefore as IDataObject,
    };
  }
  await reportClientResult(prepared.gateway, actionId, 'SUCCEEDED', null, log);
  return { response: parsed(result) as IDataObject, veefore: answer.veefore as IDataObject };
}

function addHints(context: Context, plan: Plan): void {
  if (plan.hints.length === 0) return;
  try {
    (context as ISupplyDataFunctions).addExecutionHints?.(
      ...plan.hints.map((message) => ({ message, type: 'warning' as const })),
    );
  } catch {
    // Hints are advice for the editor; never a reason to fail the run.
  }
}

async function editorTools(context: ILoadOptionsFunctions): Promise<VeeforeToolEntry[]> {
  const gateway = await gatewayFor(context);
  return (await gateway.tools({
    maxAgeMs: EDITOR_TOOLS_MAX_AGE_MS,
  })) as unknown as VeeforeToolEntry[];
}

// An AI tool node: it is a tool provider, so `usableAsTool` would add a
// second, meaningless "Veefore Tools Tool". The rule is
// @n8n/community-nodes/node-usable-as-tool; it is not named here because the
// monorepo's ESLint does not load that plugin.
// eslint-disable-next-line
export class VeeforeTools implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Veefore Tools',
    name: 'veeforeTools',
    icon: { light: 'file:veefore.svg', dark: 'file:veefore.dark.svg' },
    group: ['transform'],
    version: [1, 2, 3],
    defaultVersion: 3,
    subtitle: SUBTITLE_EXPRESSION,
    description:
      "Give an AI Agent one app's actions through Veefore, which decides every call. n8n tools connected here run only when Veefore allows the call.",
    defaults: { name: 'Veefore' },
    codex: {
      alias: ['guard', 'approval', 'policy', 'human in the loop', 'veefore', 'gmail', 'tool'],
      categories: ['AI'],
      subcategories: { AI: ['Tools'], Tools: ['Other Tools'] },
      resources: {
        primaryDocumentation: [{ url: 'https://docs.veefore.com/build/n8n' }],
      },
    },
    inputs: INPUTS_EXPRESSION,
    outputs: [{ displayName: 'Tools', type: NodeConnectionTypes.AiTool }],
    credentials: [{ name: 'veeforeApi', required: true }],
    properties: [
      {
        displayName:
          "Add the actions this agent may take. Veefore decides every call. The model fills each action's fields; values set once in Veefore (Fixed values, such as a WhatsApp phone number ID) are applied there and never shown to the model. For an action that n8n performs, connect the matching n8n tool (Gmail, Slack, …) to this node's n8n Tools input instead of to the agent.",
        name: 'notice',
        type: 'notice',
        default: '',
        displayOptions: { show: { '@version': [1] } },
      },
      {
        displayName: 'Actions',
        name: 'actions',
        type: 'fixedCollection',
        displayOptions: { show: { '@version': [1] } },
        placeholder: 'Add Action',
        typeOptions: { multipleValues: true, sortable: true },
        default: {},
        options: [
          {
            displayName: 'Action',
            name: 'action',
            values: [
              {
                displayName: 'Action Name or ID',
                name: 'tool',
                type: 'options',
                typeOptions: { loadOptionsMethod: 'getAgentTools' },
                default: '',
                required: true,
                description:
                  'One of this agent\'s actions in Veefore, with who performs it. Account values such as a phone number ID are set on the action in Veefore (Fixed values). Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
              },
              {
                displayName: 'Fields',
                name: 'fields',
                type: 'fixedCollection',
                placeholder: 'Add Field',
                typeOptions: { multipleValues: true },
                default: {},
                description:
                  'For an action Veefore performs. Fields not listed are filled by the model. Add a field to give the model a hint (✨ Defined automatically by the model) or to set its value here, so the model never sees it.',
                displayOptions: { show: { tool: [{ _cnd: { endsWith: '::veefore' } }] } },
                options: [
                  {
                    displayName: 'Field',
                    name: 'field',
                    values: [
                      {
                        displayName: 'Field Name or ID',
                        name: 'name',
                        type: 'options',
                        typeOptions: { loadOptionsMethod: 'getActionFields' },
                        default: '',
                        description:
                          'A field of this action, from Veefore. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
                      },
                      {
                        displayName: 'Value',
                        name: 'value',
                        type: 'string',
                        default: '',
                        description:
                          'A value or an expression; or let the model fill it (✨). Account setup such as a phone number ID is better set once in Veefore.',
                      },
                    ],
                  },
                ],
              },
              {
                displayName:
                  "n8n performs this action. Connect the n8n tool that performs it to this node's n8n Tools input; set its fields in that tool. It runs only when Veefore allows the call.",
                name: 'n8nNotice',
                type: 'notice',
                default: '',
                displayOptions: { show: { tool: [{ _cnd: { endsWith: N8N_PERFORMS } }] } },
              },
              {
                displayName: 'Purpose',
                name: 'purpose',
                type: 'string',
                default: '',
                description:
                  'Why the agent takes this action. Shown to approvers and recorded. Left to the model (the ✨ switch), the model says why with each call.',
              },
              {
                displayName: 'Tool Description',
                name: 'toolDescription',
                noDataExpression: true,
                type: 'string',
                typeOptions: { rows: 2 },
                default: '',
                placeholder: 'e.g. Refund an order once the customer has confirmed it',
                description:
                  'Tells the model when to use it. Leave empty to use the description from Veefore.',
              },
              {
                displayName: 'Tool Name',
                name: 'toolName',
                noDataExpression: true,
                type: 'string',
                default: '',
                placeholder: 'e.g. refund_order',
                description:
                  "The name the model calls it by. Leave empty to use the name from Veefore (or the n8n tool's own name).",
              },
            ],
          },
        ],
      },
      // Version 2: one action per node, as n8n's own tool nodes. n8n's field
      // mapper works only at a node's top level, so each action is a node.
      {
        displayName:
          'One of this agent’s actions as a tool for the AI Agent. Veefore decides every call. Add another Veefore Tools node for each further action. Values set once in Veefore (Fixed values, such as a WhatsApp phone number ID) are applied there and never shown to the model.',
        name: 'noticeV2',
        type: 'notice',
        default: '',
        displayOptions: { show: { '@version': [2] } },
      },
      {
        displayName: 'Action Name or ID',
        name: 'tool',
        type: 'options',
        typeOptions: { loadOptionsMethod: 'getAgentTools' },
        default: '',
        required: true,
        description:
          'One of this agent\'s actions in Veefore, with who performs it. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
        displayOptions: { show: { '@version': [2] } },
      },
      {
        displayName:
          "n8n performs this action. Connect the n8n tool that performs it (Gmail, Slack, …) to this node's n8n Tools input, not to the agent, and set its fields in that tool. It runs only when Veefore allows the call.",
        name: 'n8nNotice',
        type: 'notice',
        default: '',
        displayOptions: {
          show: {
            ...{ '@version': [2] },
            tool: [{ _cnd: { endsWith: N8N_PERFORMS } }],
          },
        },
      },
      {
        displayName: 'Tool Description',
        name: 'descriptionType',
        type: 'options',
        noDataExpression: true,
        options: [
          {
            name: 'Set Automatically',
            value: 'auto',
            description: 'Use the description from Veefore',
          },
          {
            name: 'Set Manually',
            value: 'manual',
            description: 'Write what the tool does and when the model should use it',
          },
        ],
        default: 'auto',
        displayOptions: { show: { '@version': [2] } },
      },
      {
        displayName: 'Description',
        name: 'toolDescription',
        type: 'string',
        noDataExpression: true,
        typeOptions: { rows: 2 },
        default: '',
        required: true,
        placeholder: 'e.g. Refund an order once the customer has confirmed it',
        description: 'Tells the model what this tool does and when to use it',
        displayOptions: {
          show: { ...{ '@version': [2] }, descriptionType: ['manual'] },
        },
      },
      {
        displayName: 'Fields',
        name: 'parameters',
        type: 'resourceMapper',
        noDataExpression: true,
        default: { mappingMode: 'defineBelow', value: null },
        required: true,
        typeOptions: {
          loadOptionsDependsOn: ['tool'],
          resourceMapper: {
            resourceMapperMethod: 'getToolFields',
            mode: 'add',
            valuesLabel: 'Fields',
            fieldWords: { singular: 'field', plural: 'fields' },
            addAllFields: true,
            multiKeyMatch: false,
            supportAutoMap: false,
            noFieldsError: 'This action has no fields to fill in.',
            // A node saved with an older field list (a dropdown, say) is
            // brought up to date when it is opened; values are kept.
            refreshStaleSchemaOnOpen: true,
          },
        },
        description:
          'Each field is defined automatically by the model unless you give it a value. A value set here is fixed and never shown to the model.',
        displayOptions: {
          show: {
            ...{ '@version': [2] },
            tool: [{ _cnd: { endsWith: VEEFORE_PERFORMS } }],
          },
        },
      },
      {
        displayName: 'Purpose',
        name: 'purpose',
        type: 'string',
        default: '',
        placeholder: 'e.g. Confirm the customer’s order',
        description:
          'Why the agent takes this action. Shown to approvers and recorded. Let the model decide it (✨) to have it say why with each call.',
        displayOptions: { show: { '@version': [2] } },
      },
      // Version 3: one app per node. The model may use the app's actions (all
      // of them, or the ones picked) and chooses the one each request needs.
      {
        displayName:
          'One app’s actions for the AI Agent, through Veefore: it decides every call. Add one Veefore Tools node per app. Who performs the app, its credential and account values (such as a WhatsApp phone number ID) are set once in Veefore.',
        name: 'noticeV3',
        type: 'notice',
        default: '',
        displayOptions: { show: { '@version': [{ _cnd: { gte: 3 } }] } },
      },
      {
        displayName: 'App Name or ID',
        name: 'app',
        type: 'options',
        typeOptions: { loadOptionsMethod: 'getAgentApps' },
        default: '',
        required: true,
        description:
          'One of the apps this agent may use in Veefore, with who performs it. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
        displayOptions: { show: { '@version': [{ _cnd: { gte: 3 } }] } },
      },
      {
        // Not shown. After the app is changed it reads `stale`, and the
        // Actions and Fields below start afresh for the new app.
        displayName: 'App Check',
        name: 'appCheck',
        type: 'hidden',
        default: APP_CHECK_EXPRESSION,
        displayOptions: { show: { '@version': [{ _cnd: { gte: 3 } }] } },
      },
      {
        displayName:
          "n8n performs this app. Connect n8n's own tools for its actions (WhatsApp, Gmail, …) to this node's n8n Tools input, not to the agent, and set their fields there. Each runs only when Veefore allows the call.",
        name: 'n8nAppNotice',
        type: 'notice',
        default: '',
        displayOptions: {
          show: {
            ...{ '@version': [{ _cnd: { gte: 3 } }] },
            app: [{ _cnd: { endsWith: '::n8n' } }],
          },
        },
      },
      {
        displayName:
          "Veefore performs this app, except the actions only n8n can (marked “n8n performs it” under Actions). Connect n8n's own tools for those to this node's n8n Tools input, not to the agent. Each runs only when Veefore allows the call.",
        name: 'mixedAppNotice',
        type: 'notice',
        default: '',
        displayOptions: {
          show: {
            ...{ '@version': [{ _cnd: { gte: 3 } }] },
            app: [{ _cnd: { endsWith: '::mixed' } }],
          },
        },
      },
      {
        displayName: 'Action Names or IDs',
        name: 'appActions',
        type: 'multiOptions',
        typeOptions: { loadOptionsMethod: 'getAppActions', loadOptionsDependsOn: ['app'] },
        // None picked is all of them, and the model picks the one each request
        // needs. Not ✨ by default: the editor's Fixed switch puts a parameter
        // back to its default, so a ✨ default could never be changed.
        default: [],
        // The editor's multi-select shows no placeholder of its own.
        hint: 'Leave it empty (or ✨) for all of them: the model picks the one each request needs',
        description:
          'Which of the app’s actions the model may use. None picked: all of them, and the model picks the one each request needs. Let the model decide (✨) to also tell it, under the switch, how to choose. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
        displayOptions: { show: { ...V3_APP_CHOSEN }, hide: { appCheck: ['stale'] } },
      },
      {
        displayName: 'Fields',
        name: 'appFields',
        type: 'resourceMapper',
        noDataExpression: true,
        default: { mappingMode: 'defineBelow', value: null },
        required: true,
        typeOptions: {
          // The app only: the editor cannot resolve a ✨ Actions value, and a
          // list that changed with every pick would lose what was set in it.
          loadOptionsDependsOn: ['app'],
          resourceMapper: {
            resourceMapperMethod: 'getAppFields',
            mode: 'add',
            valuesLabel: 'Fields',
            fieldWords: { singular: 'field', plural: 'fields' },
            // Off: a list started afresh (another app's, say) lists the
            // required fields only, as a new one does.
            addAllFields: false,
            multiKeyMatch: false,
            supportAutoMap: false,
            noFieldsError: 'These actions have no fields to fill in.',
            // Opened after the app was changed, or after the app's actions
            // changed in Veefore, the list is brought up to date.
            refreshStaleSchemaOnOpen: true,
          },
        },
        description:
          'The fields the app’s actions require, each defined automatically by the model unless you give it a value. Every other field is filled by the model too; add one to set it or to change what the model is told. A value set here is fixed for every action that has the field, and never shown to the model.',
        displayOptions: {
          show: {
            ...{ '@version': [{ _cnd: { gte: 3 } }] },
            app: [{ _cnd: { endsWith: '::veefore' } }, { _cnd: { endsWith: '::mixed' } }],
          },
          hide: { appCheck: ['stale'] },
        },
      },
      {
        displayName: 'Purpose',
        name: 'appPurpose',
        type: 'string',
        default: AUTO_PURPOSE,
        placeholder: 'e.g. Confirm the customer’s order',
        description:
          'Why the agent takes an action. Shown to approvers and recorded. Defined automatically by the model, it says why with each call.',
        displayOptions: { show: { ...V3_APP_CHOSEN } },
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        placeholder: 'Add Option',
        default: {},
        options: [
          {
            displayName: 'Do It When Approved Later',
            name: 'sendWhenApproved',
            noDataExpression: true,
            type: 'boolean',
            default: true,
            description:
              'Whether an action n8n performs runs by itself once a person approves it after the agent stopped waiting. n8n must keep running until then; otherwise the user asks again once it is approved.',
          },
          {
            displayName: 'Tool Name',
            name: 'toolName',
            type: 'string',
            noDataExpression: true,
            default: '',
            placeholder: 'e.g. refund_order',
            description:
              "The name the model calls this tool by: letters, digits, _ and -. By default the name from Veefore (or the n8n tool's own).",
            displayOptions: { show: { '@version': [2] } },
          },
          {
            displayName: 'Wait for a Decision (Minutes)',
            name: 'waitMinutes',
            noDataExpression: true,
            type: 'number',
            typeOptions: { minValue: 0, maxValue: 1440 },
            default: 2,
            description:
              'When a person must approve, how long the agent waits before answering. After that the action still happens once it is approved: Veefore performs its own actions, and this node runs the n8n ones (see the option above).',
          },
        ],
      },
    ],
  };

  methods = {
    resourceMapping: {
      /** The picked actions' fields: required ones listed, the rest left to the model. */
      async getAppFields(this: ILoadOptionsFunctions): Promise<ResourceMapperFields> {
        const app = this.getCurrentNodeParameter('app');
        if (!app) return { fields: [], emptyFieldsNotice: 'Choose the app first.' };
        const tools = appTools(await editorTools(this), app);
        if (tools.length === 0) {
          return {
            fields: [],
            emptyFieldsNotice:
              'This agent has none of that app’s actions in Veefore. Add them in Veefore, then refresh.',
          };
        }
        const veefore = tools.filter((tool) => tool.kind !== 'CLIENT');
        if (veefore.length === 0) {
          return {
            fields: [],
            emptyFieldsNotice:
              'n8n performs these actions: their fields are set in the n8n tools connected to this node.',
          };
        }
        return {
          fields: appFieldsFor(veefore, appOfValue(app)?.id),
          emptyFieldsNotice:
            'Nothing to fill in: every field of these actions is set in Veefore (Fixed values).',
        };
      },
      /** The action's fields, from Veefore: typed, required first, each ✨ by default. */
      async getToolFields(this: ILoadOptionsFunctions): Promise<ResourceMapperFields> {
        const key = keyOf(this.getCurrentNodeParameter('tool'));
        if (!key) return { fields: [], emptyFieldsNotice: 'Choose the action first.' };
        const tool = (await editorTools(this)).find((entry) => entry.key === key);
        if (!tool) {
          return {
            fields: [],
            emptyFieldsNotice:
              'This agent may not use that action. Check its access in Veefore, then refresh.',
          };
        }
        return {
          fields: fieldsFromSchema((tool.parameter_schema ?? {}) as JsonSchema, {
            fromAi: true,
            override: true,
            extrasRemoved: true,
            choicesAsText: true,
          }),
          emptyFieldsNotice:
            'Nothing to fill in: every field of this action is set in Veefore (Fixed values).',
        };
      },
    },
    loadOptions: {
      async getAgentApps(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
        return groupApps(await editorTools(this)).map((app) => ({
          name: app.name,
          value: appValue(app),
          description: `${app.tools.length} action${app.tools.length === 1 ? '' : 's'} · ${
            app.performer === 'veefore'
              ? 'Veefore performs it'
              : app.performer === 'n8n'
                ? 'n8n performs it'
                : 'Veefore and n8n perform its actions'
          }`,
        }));
      },
      async getAppActions(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
        const tools = appTools(await editorTools(this), this.getCurrentNodeParameter('app'));
        const mixed = new Set(tools.map((tool) => tool.kind === 'CLIENT')).size > 1;
        return tools.map((tool) => ({
          name: `${appOfEntry(tool).action}${mixed ? (tool.kind === 'CLIENT' ? ' (n8n performs it)' : ' (Veefore performs it)') : ''}`,
          value: tool.key,
          description: String(tool.description || tool.key),
        }));
      },
      async getActionFields(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
        const tools = (await editorTools(this)).filter((tool) => tool.kind !== 'CLIENT');
        // The action this field belongs to, from the field's own path when n8n says it.
        const path = String((this as unknown as { path?: unknown }).path ?? '');
        const index = /actions\.action\[(\d+)\]/.exec(path)?.[1];
        const params = (this.getCurrentNodeParameters() ?? {}) as {
          actions?: { action?: Array<{ tool?: unknown }> };
        };
        const picked =
          index === undefined ? null : keyOf(params.actions?.action?.[Number(index)]?.tool);
        const scope = picked ? tools.filter((tool) => tool.key === picked) : tools;
        return scope.flatMap((tool) => {
          const schema = (tool.parameter_schema ?? {}) as JsonSchema;
          const required = new Set(schema.required ?? []);
          return Object.entries(schema.properties ?? {}).map(([name, property]) => ({
            name: `${picked ? '' : `${tool.name || tool.key} › `}${property.title || labelFor(name)}${required.has(name) ? ' (required)' : ''}`,
            value: fieldValue(tool.key, name),
            description: property.description || name,
          }));
        });
      },
      async getAgentTools(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
        const tools = await editorTools(this);
        return tools.map((tool) => ({
          name: `${tool.name || tool.key} (${tool.kind === 'CLIENT' ? 'n8n performs it' : 'Veefore performs it'})`,
          value: selectionValue(tool),
          description: String((tool as { description?: unknown }).description || tool.key),
        }));
      },
    },
  };

  async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
    const node = this.getNode();
    const prepared = await prepare(this, itemIndex);
    addHints(this, prepared.plan);
    const tools = prepared.plan.entries.map((entry) => {
      const run = async (input: unknown) =>
        JSON.stringify(
          await callTool(
            this,
            prepared,
            entry,
            (input && typeof input === 'object' ? input : {}) as Record<string, unknown>,
            itemIndex,
            '',
          ),
        );
      return {
        name: entry.name,
        description: entry.description,
        schema: entry.schema,
        returnDirect: false,
        metadata: { isFromToolkit: true, sourceNodeName: node.name },
        invoke: run,
        call: run,
      };
    });
    // n8n recognises a toolkit by its shape: `tools` and `getTools()`.
    return { response: { tools, getTools: () => tools } };
  }

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const out: INodeExecutionData[] = [];
    let prepared: Prepared | null = null;
    for (let itemIndex = 0; itemIndex < Math.max(items.length, 1); itemIndex += 1) {
      const json = (items[itemIndex]?.json ?? {}) as Record<string, unknown>;
      const name = typeof json.tool === 'string' ? json.tool : '';
      try {
        prepared ??= await prepare(this, itemIndex);
        const entry = prepared.plan.entries.find((candidate) => candidate.name === name);
        const result = entry
          ? await callTool(this, prepared, entry, json, itemIndex, String(json.toolCallId ?? ''))
          : { status: 'refused', message: TOOLS_MESSAGES.unknownCall(name) };
        out.push({ json: result, pairedItem: { item: itemIndex } });
      } catch (error) {
        // Fail closed, and tell the model, rather than stopping the agent.
        out.push({
          json: {
            status: 'error',
            message: `Veefore could not be asked (${(error as Error).message}), so it was NOT done. Tell the user to try again in a moment.`,
          },
          pairedItem: { item: itemIndex },
        });
      }
    }
    return [out];
  }
}

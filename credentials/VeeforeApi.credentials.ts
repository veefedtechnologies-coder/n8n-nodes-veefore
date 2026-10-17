import type { ICredentialType, INodeProperties } from 'n8n-workflow';

/**
 * The agent's identity, held by n8n's encrypted credential store.
 *
 * This is an *agent* credential: an Ed25519 private key that lets the
 * workflow prove it is one specific Veefore agent. It grants no authority of
 * its own — every request it signs still goes through the agent's
 * capabilities, policy, risk and approvals at the Veefore gateway — and it is
 * never a Veefore administrator credential. Provider secrets (Gmail, Stripe,
 * a database) stay in the Veefore credential broker and never reach n8n.
 */
export class VeeforeApi implements ICredentialType {
  name = 'veeforeApi';

  displayName = 'Veefore Agent API';

  documentationUrl = 'https://docs.veefore.com/build/n8n';

  icon = { light: 'file:veefore.svg', dark: 'file:veefore.dark.svg' } as const;

  properties: INodeProperties[] = [
    {
      displayName: 'Gateway URL',
      name: 'gatewayUrl',
      type: 'string',
      default: '',
      placeholder: 'https://gateway.veefore.com',
      required: true,
      description: 'The Veefore gateway (enforcement plane), not the console.',
    },
    {
      displayName: 'Agent ID',
      name: 'agentId',
      type: 'string',
      default: '',
      placeholder: 'agt_…',
      required: true,
    },
    {
      displayName: 'Key ID',
      name: 'keyId',
      type: 'string',
      default: '',
      placeholder: 'key_…',
      required: true,
      description: 'The identity key ID shown when the agent key was created or rotated.',
    },
    {
      displayName: 'Private Key',
      name: 'privateKey',
      type: 'string',
      typeOptions: { password: true, rows: 4 },
      default: '',
      required: true,
      description:
        'Ed25519 private key: base64 PKCS#8 as Veefore shows it, or PEM. Used only to sign a two-minute identity assertion.',
    },
    {
      displayName: 'Runtime Connection ID',
      name: 'runtimeConnectionId',
      type: 'string',
      default: '',
      placeholder: 'rtc_…',
      description:
        'The Veefore runtime this instance is registered as. Sent with each action so Veefore can check it matches the agent’s binding.',
    },
  ];
}

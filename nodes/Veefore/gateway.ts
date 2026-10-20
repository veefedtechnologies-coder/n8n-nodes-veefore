import {
  sleep,
  type IDataObject,
  type IExecuteFunctions,
  type ILoadOptionsFunctions,
} from 'n8n-workflow';
import { VeeforeGateway, credentialsFromData, type HttpFn } from '../../lib/veefore';

type Http = IExecuteFunctions['helpers'] | ILoadOptionsFunctions['helpers'];

/** n8n's httpRequest helper, which honours the instance's proxy settings. */
export function httpFrom(helpers: Http): HttpFn {
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

export async function gatewayFor(
  context: IExecuteFunctions | ILoadOptionsFunctions,
): Promise<VeeforeGateway> {
  const data = (await context.getCredentials('veeforeApi')) as IDataObject;
  return new VeeforeGateway(credentialsFromData(data), httpFrom(context.helpers), sleep);
}

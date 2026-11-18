export class AppError extends Error {
  constructor(status, code, message, retryable = false) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export function providerError(error) {
  if (error instanceof AppError) return error;
  const status = Number(error?.status ?? error?.code);
  if (status === 401 || status === 403) {
    return new AppError(502, 'AUTH_FAILED',
      'SAP AI Core rejected the credentials or resource-group/model permissions. Verify access again.');
  }
  if (status === 404) {
    return new AppError(422, 'MODEL_UNAVAILABLE',
      'The configured SAP AI Core model deployment is unavailable. Check the resource group and deployment, then verify access. No substitute was selected.');
  }
  if (status === 429) {
    return new AppError(429, 'RATE_LIMITED',
      'SAP AI Core or the model provider reached its quota or rate limit. Try again later.', true);
  }
  if (status === 400 || status === 415 || status === 422) {
    return new AppError(422, 'PROVIDER_REJECTED',
      'SAP AI Core rejected the request or input format. The model was not changed.');
  }
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError' || status === 504) {
    return new AppError(504, 'TIMEOUT', 'SAP AI Core took too long to respond. Try again.', true);
  }
  if (['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT'].includes(error?.cause?.code)) {
    return new AppError(502, 'TLS_ERROR',
      'The SAP connection certificate is not trusted. Check your Windows trust store or set NODE_USE_SYSTEM_CA=1 for the server. Never disable TLS verification.');
  }
  return new AppError(502, 'PROVIDER_UNREACHABLE',
    'Cannot reach SAP AI Core. Check your internet/VPN connection and try again.', true);
}

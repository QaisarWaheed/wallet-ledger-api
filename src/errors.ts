/** Error codes from the API contract, plus two for routing/server failures. */
export type ErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'user_not_found'
  | 'insufficient_funds'
  | 'not_found'
  | 'internal_error';

export interface ErrorBody {
  readonly error: ErrorCode;
  readonly message: string;
}

/** An expected, client-facing failure with a fixed HTTP status and error code. */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  toBody(): ErrorBody {
    return { error: this.code, message: this.message };
  }
}

export const invalidRequest = (message: string): ApiError =>
  new ApiError(400, 'invalid_request', message);

export const unauthorized = (): ApiError =>
  new ApiError(401, 'unauthorized', 'Missing or invalid bearer token');

export const userNotFound = (): ApiError =>
  new ApiError(404, 'user_not_found', 'User has never been credited');

export const insufficientFunds = (): ApiError =>
  new ApiError(409, 'insufficient_funds', 'Balance is lower than the debit amount');

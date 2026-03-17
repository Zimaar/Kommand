export enum ErrorCode {
  UNAUTHORIZED = 'UNAUTHORIZED',
  NOT_FOUND = 'NOT_FOUND',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  TOOL_EXECUTION_ERROR = 'TOOL_EXECUTION_ERROR',
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
  EXTERNAL_API_ERROR = 'EXTERNAL_API_ERROR',
}

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly isOperational: boolean;

  constructor(message: string, statusCode: number, code: ErrorCode, isOperational = true) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = isOperational;
    Error.captureStackTrace(this, this.constructor);
  }

  static unauthorized(message = 'Unauthorized') {
    return new AppError(message, 401, ErrorCode.UNAUTHORIZED);
  }

  static notFound(message = 'Not found') {
    return new AppError(message, 404, ErrorCode.NOT_FOUND);
  }

  static validationError(message: string) {
    return new AppError(message, 400, ErrorCode.VALIDATION_ERROR);
  }

  static toolExecutionError(message: string) {
    return new AppError(message, 500, ErrorCode.TOOL_EXECUTION_ERROR, false);
  }

  static rateLimitExceeded(message = 'Rate limit exceeded') {
    return new AppError(message, 429, ErrorCode.RATE_LIMIT_EXCEEDED);
  }

  static externalApiError(message: string) {
    return new AppError(message, 502, ErrorCode.EXTERNAL_API_ERROR, false);
  }
}

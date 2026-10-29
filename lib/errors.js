'use strict';

class PythError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'PythError';
    this.code = options.code || 'PYTH_ERROR';
    this.domain = true;
    this.status = options.status ?? null;
    this.retryable = options.retryable === true;
    this.retryAfterMs = Number.isFinite(options.retryAfterMs) ? options.retryAfterMs : null;
    this.details = options.details;
  }
}

class ConfigError extends PythError {
  constructor(message, options = {}) {
    super(message, { ...options, code: options.code || 'CONFIG_ERROR' });
    this.name = 'ConfigError';
  }
}

class ValidationError extends PythError {
  constructor(message, options = {}) {
    super(message, { ...options, code: options.code || 'VALIDATION_ERROR' });
    this.name = 'ValidationError';
  }
}

function publicError(error) {
  if (error instanceof PythError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.status === null ? {} : { status: error.status }),
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  return { code: 'INTERNAL_ERROR', message: error && error.message ? error.message : String(error) };
}

module.exports = { PythError, ConfigError, ValidationError, publicError };

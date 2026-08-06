// Uniform error handling. Routes throw `HttpError`; the Fastify error handler
// maps those plus Zod validation failures to the `{ error: { code, message } }`
// envelope (04-api-spec) with the right status code.
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from 'fastify-type-provider-zod';

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string, code = 'BAD_REQUEST') => new HttpError(400, code, message);
export const unauthorized = (message = 'Unauthorized', code = 'UNAUTHENTICATED') => new HttpError(401, code, message);
export const forbidden = (message = 'Forbidden', code = 'FORBIDDEN') => new HttpError(403, code, message);
export const notFound = (message = 'Not found', code = 'NOT_FOUND') => new HttpError(404, code, message);
export const conflict = (message: string, code = 'CONFLICT') => new HttpError(409, code, message);

interface ErrorBody {
  error: { code: string; message: string };
}

export function errorHandler(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply): void {
  if (err instanceof HttpError) {
    void reply.status(err.statusCode).send(body(err.code, err.message));
    return;
  }

  // Request validation failures from fastify-type-provider-zod.
  if (hasZodFastifySchemaValidationErrors(err)) {
    const message = err.validation
      .map((v) => `${v.instancePath || v.params?.issue?.path?.join('.') || 'body'}: ${v.message}`)
      .join('; ');
    void reply.status(400).send(body('VALIDATION_ERROR', message || 'Validation failed'));
    return;
  }

  // Bare ZodError (e.g. thrown manually while parsing).
  if (err instanceof ZodError) {
    const message = err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    void reply.status(400).send(body('VALIDATION_ERROR', message));
    return;
  }

  if (isResponseSerializationError(err)) {
    req.log.error({ err }, 'response serialization error');
    void reply.status(500).send(body('INTERNAL_ERROR', 'Response did not match schema'));
    return;
  }

  // Fastify built-in errors carry a statusCode (e.g. 400 malformed JSON).
  const statusCode = (err as FastifyError).statusCode;
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
    void reply.status(statusCode).send(body((err as FastifyError).code ?? 'BAD_REQUEST', err.message));
    return;
  }

  req.log.error({ err }, 'unhandled error');
  void reply.status(500).send(body('INTERNAL_ERROR', 'Internal server error'));
}

function body(code: string, message: string): ErrorBody {
  return { error: { code, message } };
}

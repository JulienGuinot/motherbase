import { ApplicationError } from './application-error';

export class HttpException extends ApplicationError {
  constructor(message: string, statusCode: number, code?: string, options?: { expose?: boolean }) {
    super(statusCode, message, { code, expose: options?.expose });
  }
}

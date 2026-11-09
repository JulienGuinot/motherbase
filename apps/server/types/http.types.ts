/** What a service hands back to a controller before it becomes an HTTP response. */
export interface ServiceResponse<T extends object = object> {
  data?: T;
  message: string;
  /** HTTP status to use when this is an error response (no data). */
  statusCode?: number;
}

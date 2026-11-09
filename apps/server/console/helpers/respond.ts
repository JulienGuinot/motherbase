import type { Response } from 'express';

export const ok = (res: Response, data: unknown) => res.status(200).json({ success: true, data });

export const fail = (res: Response, code: number, message: string) =>
  res.status(code).json({ success: false, message });

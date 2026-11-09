import { Request, Response, NextFunction } from 'express';
import { sessionUser } from './auth/session';
import { UserRole } from './services/users.service';

export { requireProjectCapability } from './auth/capabilities';

// Authorization middlewares for the Platform Console. They read the live
// identity attached to req.user by requireSession, so they must always run
// AFTER it in the chain.

const forbid = (res: Response) => res.status(403).json({ success: false, message: 'Forbidden' });
const unauth = (res: Response) => res.status(401).json({ success: false, message: 'Unauthorized' });

/** Allow only the listed roles; 403 otherwise. */
export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = sessionUser(req);
    if (!user) return unauth(res);
    return roles.includes(user.role) ? next() : forbid(res);
  };
}

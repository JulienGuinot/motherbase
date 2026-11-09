import { Blobatar } from "@blobatar/react";
import type { AdminUser } from "../types";
import "blobatar/motion.css";


export function Avatar({ user }: { user: AdminUser }) {
    const isAdmin = user.role === 'ADMIN';
    const src = user.image || user.imageUrl;

    // Plain img, not next/image: provider avatars come from arbitrary hosts
    // (googleusercontent, avatars.githubusercontent, a project's own bucket) and
    // next/image refuses any host absent from images.remotePatterns.
    if (src)
        return (
            <img
                src={src}
                alt=""
                width={32}
                height={32}
                className="h-8 w-8 shrink-0 rounded-full object-cover"
            />
        );


    if (isAdmin) return (
        <Blobatar
            name={user.username}
            animate="always"
            size={32}
        />
    );
    return (
        <Blobatar
            name={user.username}
            animate="always"
            size={32}
        />
    );
}
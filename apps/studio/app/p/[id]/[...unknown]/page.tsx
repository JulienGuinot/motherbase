import { notFound } from 'next/navigation';

// Next only falls back to the *root* not-found.tsx for a URL that matches no
// route, which would drop an unknown project sub-page out of the project
// layout: no nav, no topbar, and no `id` for NotFound to offer "Back to
// project". Catching the path here instead keeps it inside /p/[id] and lets
// the sibling not-found.tsx render in place.
export default function UnknownProjectPage() {
  notFound();
}

'use client';

import type { ReactNode } from 'react';
import NavPanel from '@/shared/ui/NavPanel';
import { PRODUCT_BY_KEY } from '@/shared/lib/nav';

// Route layout for a product that has a static contextual panel (Database,
// Authentication, …). Renders the panel beside the routed page. Products
// without a panel route their page directly under Layout's Outlet.
export default function ProductLayout({ productKey, children }: { productKey: string; children: ReactNode }) {
  const product = PRODUCT_BY_KEY[productKey];

  return (
    // Fill the area under the topbar with a *definite* height so a routed page
    // built as `flex-1 min-h-0 overflow-*` (e.g. a table-list + detail layout)
    // constrains and scrolls internally instead of growing and dragging its
    // own sidebar out of view. The content column owns the scroll, so long-form
    // pages still scroll while the NavPanel (sticky) and any page sidebar stay put.
    //
    // On phones, Layout's <main> pads its bottom to clear the floating nav pill.
    // That padding only works on the element that scrolls: here it would leave a
    // dead band under this column. So cancel it and pad the scroller instead,
    // and the pill floats over the content as it does on every other page.
    <div className="-mb-[calc(4rem+env(safe-area-inset-bottom))] flex flex-1 min-h-0 flex-col md:mb-0 md:flex-row">
      {product?.panel && <NavPanel base={product.base} config={product.panel} />}
      <div className="flex min-w-0 flex-1 flex-col min-h-0 overflow-y-auto pb-[calc(4rem+env(safe-area-inset-bottom))] md:pb-0">
        {children}
      </div>
    </div>
  );
}

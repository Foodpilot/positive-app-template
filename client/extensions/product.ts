import { startSlotPage } from "./slot.js";

// Product tab: the server reads the product id from the verified session token, never from the page.
void startSlotPage<{ id: number; name: string }>("/api/extension/product", (product) => `Product: ${product.name}`);

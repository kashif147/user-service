# Product / Pricing management

Clean three-level hierarchy: `ProductType` (tenant-scoped) → `Product` (FK `productTypeId`, optional
`incomeAccountCode` for GL mapping on non-membership products) → `Pricing` (FK `productId`,
time-boxed via `effectiveFrom`/`effectiveTo`, a `getCurrentPricing` static picks the active row for a
date).

All three publish domain events (`product.type.*.v1`, `product.*.v1`, `pricing.*.v1`) to the
`product.events` exchange on every create/update/delete — that is the sync mechanism other services
(events-service, account-service) rely on to stay current. There is no polling or bulk-sync endpoint,
so a missed/failed publish is the only way those services fall out of sync.

# RabbitMQ

Publishes `user.crm.created/updated.v1` and `user.portal.created/updated.v1` (exchange
`user.events`) on user changes, and the six product/pricing events described in
`product-pricing.md` (exchange `product.events`).

Consumes `applications.review.processed.v1` (exchange `application.events`, upgrades
Non-Member→Member) and subscription resignation/cancellation/grace-ended/undo events (exchange
`membership.events`, drives role demotion/promotion).

If `RABBIT_URL`/`RABBITMQ_URL` is unset, init/publish/consume all silently no-op with a console
warning rather than failing startup — same pattern as every other service in this platform, don't
treat a missing RabbitMQ connection as a startup failure when diagnosing this service.

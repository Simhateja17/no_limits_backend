-- Check channels by type
SELECT type, COUNT(*) as count FROM "Channel" GROUP BY type;

-- Check orders by origin  
SELECT "orderOrigin", COUNT(*) as count FROM "Order" GROUP BY "orderOrigin";

-- Check if there are WooCommerce channels with Shopify-origin orders
SELECT 
  c.type as channel_type,
  o."orderOrigin" as order_origin,
  COUNT(*) as count
FROM "Order" o
JOIN "Channel" c ON o."channelId" = c.id
WHERE c.type = 'woocommerce'
GROUP BY c.type, o."orderOrigin";

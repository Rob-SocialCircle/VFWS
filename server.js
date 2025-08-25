import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import crypto from "crypto";

dotenv.config();
const app = express();

app.use(express.json());

function verifyShopifyWebhook(req) {
  try {
    const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
    const secret = process.env.SHOPIFY_API_SECRET; 

    // Use the raw Buffer body, not parsed JSON
    const digest = crypto
      .createHmac("sha256", secret)
      .update(req.body, "utf8")   // req.body is Buffer thanks to express.raw()
      .digest("base64");

    return crypto.timingSafeEqual(
      Buffer.from(digest, "utf8"),
      Buffer.from(hmacHeader, "utf8")
    );
  } catch (err) {
    console.error("HMAC verification error:", err);
    return false;
  }
}
const createdDeliveriesByOrderId = new Map();

app.post("/carrier_service", async (req, res) => {
    try {
        const { rate } = req.body;
        if (!rate) return res.status(400).json({error: "Bad payload"});
        const dest = rate.destination
        const origin = rate.origin

        if (!dest || dest.country !== "US") {
            return res.json({ rates: [] });
        }

        const pickupAddress = origin?.address1 
        ? `${origin.address1} ${origin.city} ${origin.province} ${origin.postal_code}`
        : "184 Lexington Ave New York NY 10016"

        const deliveryAddress = `${dest.address1} ${dest.city} ${dest.province} ${dest.postal_code}`

        if (dest.postal_code == "10016") {
            return res.json({ rates: [] });
        }

        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 8000);

        const metrobiResp = await fetch(
            "https://delivery-api.metrobi.com/api/v1/deliveryrate",
            {
                method: "POST",
                headers: {
                    "accept": 'application/json',
                    "x-api-key": `${process.env.METROBI_API_KEY}`,
                    "content-type": "application/json"
                },
                body: JSON.stringify({
                    size: 'suv',
                    pickup_stop: {address: pickupAddress},
                    dropoff_stop: {address: deliveryAddress},
                }),
                signal: controller.signal
            }
        );

        clearTimeout(t);

        if (!metrobiResp.ok) {
            return res.json({
                rates: [
                  {
                    service_name: "⚠️ Metrobi Delivery - Temporarily Unavailable",
                    service_code: "METROBI_UNAVAILABLE",
                    total_price: "999900", 
                    currency: "USD",
                    description: "Metrobi could not calculate delivery for this address"
                  }
                ]
              });
        }

        

        const metrobiData = await metrobiResp.json();

        if (!metrobiData.success) {
            return res.json({
                rates: [
                  {
                    service_name: "⚠️ Metrobi Delivery - Temporarily Unavailable",
                    service_code: "METROBI_UNAVAILABLE",
                    total_price: "999900", 
                    currency: "USD",
                    description: "Metrobi could not calculate delivery for this address"
                  }
                ]
              });
        }

        const estimatedCost = metrobiData.response.data.price

        if (typeof estimatedCost !== "number"){
            return res.json({
                rates: [
                  {
                    service_name: "⚠️ Metrobi Delivery - Temporarily Unavailable",
                    service_code: "METROBI_UNAVAILABLE",
                    total_price: "999900", 
                    currency: "USD",
                    description: "Metrobi could not calculate delivery for this address"
                  }
                ]
              });
        }

        return res.json({
            rates: [
                {
                    service_name:"Metrobi Delivery",
                    service_code: "METROBI",
                    description: "Same-day local courier powered by Metrobi",
                    total_price: Math.round(estimatedCost * 100).toString(),
                    currency: "USD"
                }
            ]
        });


    } catch (error) {
        console.error("Carrier service error:", error);
        return res.json({
            rates: [
              {
                service_name: "⚠️ Metrobi Delivery - Temporarily Unavailable",
                service_code: "METROBI_UNAVAILABLE",
                total_price: "999900", 
                currency: "USD",
                description: "Metrobi could not calculate delivery for this address"
              }
            ]
          });
    }
})

app.post(
  "/webhooks/orders_create",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    if (!verifyShopifyWebhook(req)) return res.sendStatus(401);

    let order;
    try {
      order = JSON.parse(req.body.toString("utf8")); 
    } catch (e) {
      console.error("Failed to parse order JSON:", e);
      return res.sendStatus(400);
    }

    try {
      // Only act if the buyer chose Metrobi at checkout
      const usedMetrobi =
        Array.isArray(order.shipping_lines) &&
        order.shipping_lines.some(
          (sl) =>
            (sl.title || "").toLowerCase().includes("metrobi") ||
            (sl.code || "").toUpperCase() === "METROBI"
        );

      if (!usedMetrobi) return res.sendStatus(200);

      const orderId = order.id;

      // If we've already created a Metrobi job for this order, do nothing.
      if (createdDeliveriesByOrderId.has(orderId)) return res.sendStatus(200);

      const pickupAddress =
        process.env.PICKUP_ADDRESS || "184 Lexington Ave New York NY 10016";

      const sa = order.shipping_address || {};
      const dropoffAddress = `${sa.address1 || ""} ${sa.city || ""} ${
        sa.province || ""
      } ${sa.zip || ""}`.trim();

      const now = new Date();
      const threeHoursLater = new Date(now.getTime() + 3 * 60 * 60 * 1000);

      const metrobiPayload = {
        size: "suv",
        pickup_stop: {
          address: pickupAddress,
          contact_name:
            order.shipping_address?.name ||
            order.customer?.first_name ||
            "Store",
          contact_phone:
            order.shipping_address?.phone ||
            order.customer?.phone ||
            order.contact_email,
          notes: `Order #${order.name} (${order.id})`,
        },
        dropoff_stop: {
          address: dropoffAddress,
          contact_name: order.shipping_address?.name,
          contact_phone:
            order.shipping_address?.phone ||
            order.customer?.phone ||
            order.contact_email,
          notes: order.note || "Deliver Shopify order",
        },

        pickup_start_time: now.toISOString(),
        pickup_end_time: threeHoursLater.toISOString(),
        reference: `shopify:${order.id}`,
      };

      // Create delivery with Metrobi
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      const metrobiResp = await fetch(process.env.METROBI_CREATE_URL, {
        method: "POST",
        headers: {
          accept: "application/json",
          "x-api-key": process.env.METROBI_API_KEY,
          "content-type": "application/json",
        },
        body: JSON.stringify(metrobiPayload),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!metrobiResp.ok) {
        console.error("Metrobi create failed", await metrobiResp.text());
        return res.sendStatus(500);
      }

      const metrobiData = await metrobiResp.json();

      const deliveryId =
        metrobiData.id ||
        metrobiData.delivery_id ||
        metrobiData.response?.data?.id;
      const trackingUrl =
        metrobiData.tracking_url ||
        metrobiData.response?.data?.tracking_url;

      createdDeliveriesByOrderId.set(orderId, { deliveryId, trackingUrl });

      // Create a Shopify Fulfillment WITH tracking
      try {
        await createShopifyFulfillment({
          shop: req.get("X-Shopify-Shop-Domain"),
          token: process.env.SHOPIFY_ADMIN_TOKEN,
          orderId,
          trackingNumber: String(deliveryId || orderId),
          trackingUrl: trackingUrl || "https://metrobi.com/track",
          trackingCompany: "Metrobi Courier",
          notifyCustomer: true,
        });
      } catch (e) {
        console.error("Fulfillment create failed", e);
        // Do not fail the webhook; the Metrobi job is already created.
      }

      return res.sendStatus(200);
    } catch (e) {
      console.error("orders_create handler error", e);
      return res.sendStatus(500);
    }
  }
);


app.listen(process.env.PORT, () => {
    console.log(`Carrier service listening on port ${process.env.PORT}`)
})
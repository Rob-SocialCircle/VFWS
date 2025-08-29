import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import crypto from "crypto";

dotenv.config();
const app = express();

app.use((req, res, next) => {
  if (req.originalUrl.startsWith("/webhooks")) {
    next();
  }
  else {
    express.json()(req, res, next);
  }
});

function verifyShopifyWebhook(req) {
  try {
    const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
    const secret = process.env.SHOPIFY_API_SECRET;
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body))


    const digest = crypto
      .createHmac("sha256", secret)
      .update(body, "utf8")
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
    if (!rate) return res.status(400).json({ error: "Bad payload" });
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
          pickup_stop: { address: pickupAddress },
          dropoff_stop: { address: deliveryAddress },
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

    if (typeof estimatedCost !== "number") {
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
          service_name: "Metrobi Delivery",
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

async function createShopifyFulfillment({
  shop,
  token,
  orderId,
  trackingNumber,
  trackingUrl,
  trackingCompany,
  notifyCustomer,
}) {
  try {
    const orderRes = await fetch(
      `https://${shop}/admin/api/2025-01/orders/${orderId}.json`,
      {
        method: "GET",
        headers: {
          "X-Shopify-Access-Token": token,
          "Content-Type": "application/json",
        },
      }
    );

    if (!orderRes.ok) {
      throw new Error(`Failed to fetch order: ${orderRes.statusText}`);
    }
    console.log(`The following order was fetched`, JSON.stringify(orderRes, null, 2))

    const orderData = await orderRes.json();
    const lineItems = orderData.order.line_items.map((item) => ({
      id: item.id,
      quantity: item.fulfillable_quantity,
    }));

    // 2. Build fulfillment payload (legacy API expects these keys)
    const fulfillmentPayload = {
      fulfillment: {
        location_id: orderData.order.location_id, 
        tracking_number: trackingNumber,
        tracking_url: trackingUrl,
        tracking_company: trackingCompany,
        notify_customer: notifyCustomer,
        line_items: lineItems,
      },
    };

    console.log(`Attempting to fetch from fulfillments.json`)


    const res = await fetch(
      `https://${shop}/admin/api/2025-01/orders/${orderId}/fulfillments.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(fulfillmentPayload),
      }
    );

    console.log(`Checking response`, JSON.stringify(res, null, 2))

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Shopify fulfillment create failed (${res.status}): ${text}`
      );
    }
    console.log(`Fetch successful. Await res.json`)

    const data = await res.json();
    console.log(`Data found\n`, JSON.stringify(data, null, 2))
    return data.fulfillment;
  } catch (err) {
    console.error("Fulfillment create failed", err);
    throw err;
  }
}

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

    console.log("Order used\n", JSON.stringify(order, null, 2))

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


      const sa = order.shipping_address || {};
      const now = new Date();
      const pickup_time = {
        date: now.toISOString().split("T")[0], // YYYY-MM-DD
        time: now.toISOString().split("T")[1].substring(0,5) // HH:MM
      };

      const metrobiPayload = {
        pickup_time,
        pickup_stop: {
          contact: {
            phone: order.customer?.phone || null,
            email: order.email || null,
          },
          name: "Vino Fine Wine & Spirits", 
          address: "184 Lexington Ave New York NY 10016",
          address2: "",
          instructions: "Walk through the front door",
          business_name: order.billing_address?.company || "Metrobi Inc",
        },
        dropoff_stop: {
          contact: {
            phone: sa.phone || order.customer?.phone || null,
            email: order.email || null,
          },
          name: sa.name || `order.customer?.first_name ${order.customer.last_name}` || "Recipient",
          address: `${sa.address1 || ""} ${sa.city || ""} ${sa.province || ""} ${sa.zip || ""}`.trim(),
          address2: sa.address2 || "",
          instructions: sa.company ? `Deliver to company: ${sa.company}` : "Leave at front door",
        },
        settings: {
          merge_delivery: false,
          return_to_pickup: false,
        },
        size: "suv",
        job_description: `Deliver Shopify Order #${order.name} (${order.id})`,
      };

      console.log("Metrobi Payload\n", JSON.stringify(metrobiPayload, null, 2))

      // Create delivery with Metrobi
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      const metrobiResp = await fetch(process.env.METROBI_TEST_CREATE_URL, {
        method: "POST",
        headers: {
          accept: "application/json",
          "x-api-key": process.env.METROBI_TEST_API_KEY,
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

      console.log("metrobiData\n", JSON.stringify(metrobiData, null, 2))

      const deliveryId =
        metrobiData.id ||
        metrobiData.delivery_id ||
        metrobiData.response?.data?.id;
      const trackingUrl =
        metrobiData.tracking_url ||
        metrobiData.response?.data?.tracking_url;

      createdDeliveriesByOrderId.set(orderId, { deliveryId, trackingUrl });

      //Create a Shopify Fulfillment WITH tracking
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
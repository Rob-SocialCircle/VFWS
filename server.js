import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();
const app = express();

app.use(express.json());

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
                    total_price: "999900", // $0 but looks like a message
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
                    total_price: "999900", // $0 but looks like a message
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
                    total_price: "999900", // $0 but looks like a message
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
                total_price: "999900", // $0 but looks like a message
                currency: "USD",
                description: "Metrobi could not calculate delivery for this address"
              }
            ]
          });
    }
})


app.listen(process.env.PORT, () => {
    console.log(`Carrier service listening on port ${process.env.PORT}`)
})
const dns = require("node:dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);

const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
dotenv.config();
const { MongoClient, ServerApiVersion, ObjectId  } = require('mongodb');
const uri = process.env.MONGODB_URI;
const app = express();
app.use(cors());
app.use(express.json());
const port = process.env.port || 5000;

const MAX_IMAGES = 4;
const DEFAULT_DELIVERY_CHARGE = 60;
const ORDER_STATUSES = ["pending", "confirmed", "shipped", "delivered", "cancelled"];
const FINAL_ORDER_STATUSES = ["delivered", "cancelled"];

const isValidUrl = (value) => {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const { protocol } = new URL(value.trim());
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
};

//Image Handler
const validateImages = (images) => {
  if (!Array.isArray(images)) return "images must be an array of URLs";
  if (images.length < 1 || images.length > MAX_IMAGES) {
    return `images must contain between 1 and ${MAX_IMAGES} URLs`;
  }
  if (!images.every(isValidUrl)) return "every item in images must be a valid http(s) URL";
  return null;
};

//Order Handler (COD only)
const validateOrder = (body) => {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "order body must be an object" };
  }

  const customer = body.customer;
  if (!customer || typeof customer !== "object" || Array.isArray(customer)) {
    return { error: "customer { name, phone, address } is required" };
  }
  const name = typeof customer.name === "string" ? customer.name.trim() : "";
  const phone = typeof customer.phone === "string" ? customer.phone.trim() : "";
  const address = typeof customer.address === "string" ? customer.address.trim() : "";
  if (!name) return { error: "customer.name is required" };
  if (!phone) return { error: "customer.phone is required" };
  if (!address) return { error: "customer.address is required" };

  if (!Array.isArray(body.items) || body.items.length === 0) {
    return { error: "items must be a non-empty array of { productId, quantity }" };
  }

  const seen = new Set();
  const items = [];
  for (const entry of body.items) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { error: "each item must be an object { productId, quantity }" };
    }
    const productId = typeof entry.productId === "string" ? entry.productId.trim() : "";
    if (!ObjectId.isValid(productId)) {
      return { error: `invalid productId: ${entry.productId}` };
    }
    if (seen.has(productId)) {
      return { error: `duplicate productId: ${productId}` };
    }
    seen.add(productId);

    const quantity = Number(entry.quantity);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      return { error: `quantity for product ${productId} must be a positive integer` };
    }
    items.push({ productId, quantity });
  }

  // COD only: default to cod, reject anything else
  let paymentMethod = "cod";
  if (body.paymentMethod !== undefined) {
    paymentMethod = typeof body.paymentMethod === "string" ? body.paymentMethod.trim().toLowerCase() : "";
    if (paymentMethod !== "cod") {
      return { error: "paymentMethod must be cod" };
    }
  }

  let deliveryCharge = DEFAULT_DELIVERY_CHARGE;
  if (body.deliveryCharge !== undefined) {
    deliveryCharge = Number(body.deliveryCharge);
    if (!Number.isFinite(deliveryCharge) || deliveryCharge < 0) {
      return { error: "deliveryCharge must be a number >= 0" };
    }
  }

  let note = "";
  if (body.note !== undefined) {
    if (typeof body.note !== "string") {
      return { error: "note must be a string" };
    }
    note = body.note.trim();
    if (note.length > 500) {
      return { error: "note must be at most 500 characters" };
    }
  }

  return {
    value: {
      customer: { name, phone, address },
      items,
      paymentMethod,
      deliveryCharge,
      note,
    },
  };
};

//Partial validator for PATCH /orders/:id (Option B: keep old unitPrice)
const validateOrderPatch = (body) => {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "order update body must be an object" };
  }

  const IMMUTABLE = ["_id", "paymentMethod", "totalAmount", "subtotal", "itemCount", "createdAt"];
  for (const key of IMMUTABLE) {
    if (key in body) {
      return { error: `${key} cannot be updated` };
    }
  }

  const value = {};
  let hasField = false;

  if ("customer" in body) {
    const customer = body.customer;
    if (!customer || typeof customer !== "object" || Array.isArray(customer)) {
      return { error: "customer must be an object { name?, phone?, address? }" };
    }
    const patch = {};
    for (const key of ["name", "phone", "address"]) {
      if (key in customer) {
        if (typeof customer[key] !== "string" || !customer[key].trim()) {
          return { error: `customer.${key} must be a non-empty string` };
        }
        patch[key] = customer[key].trim();
      }
    }
    if (Object.keys(patch).length === 0) {
      return { error: "customer must contain at least one of name, phone, address" };
    }
    value.customer = patch;
    hasField = true;
  }

  if ("note" in body) {
    if (typeof body.note !== "string") {
      return { error: "note must be a string" };
    }
    const note = body.note.trim();
    if (note.length > 500) {
      return { error: "note must be at most 500 characters" };
    }
    value.note = note;
    hasField = true;
  }

  if ("deliveryCharge" in body) {
    const deliveryCharge = Number(body.deliveryCharge);
    if (!Number.isFinite(deliveryCharge) || deliveryCharge < 0) {
      return { error: "deliveryCharge must be a number >= 0" };
    }
    value.deliveryCharge = deliveryCharge;
    hasField = true;
  }

  if ("orderStatus" in body) {
    const orderStatus = typeof body.orderStatus === "string" ? body.orderStatus.trim().toLowerCase() : "";
    if (!ORDER_STATUSES.includes(orderStatus)) {
      return { error: `orderStatus must be one of: ${ORDER_STATUSES.join(", ")}` };
    }
    value.orderStatus = orderStatus;
    hasField = true;
  }

  if ("items" in body) {
    if (!Array.isArray(body.items) || body.items.length === 0) {
      return { error: "items must be a non-empty array of { productId, quantity }" };
    }
    const seen = new Set();
    const items = [];
    for (const entry of body.items) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return { error: "each item must be an object { productId, quantity }" };
      }
      const productId = typeof entry.productId === "string" ? entry.productId.trim() : "";
      if (!ObjectId.isValid(productId)) {
        return { error: `invalid productId: ${entry.productId}` };
      }
      if (seen.has(productId)) {
        return { error: `duplicate productId: ${productId}` };
      }
      seen.add(productId);
      const quantity = Number(entry.quantity);
      if (!Number.isInteger(quantity) || quantity <= 0) {
        return { error: `quantity for product ${productId} must be a positive integer` };
      }
      items.push({ productId, quantity });
    }
    value.items = items;
    hasField = true;
  }

  if (!hasField) {
    return { error: "No fields to update" };
  }
  return { value };
};

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});
async function run() {
  try {
    await client.connect();

    const db = client.db("dolna_db");
    const productsCollection = db.collection("products");
    const ordersCollection = db.collection("orders");

    //Add Products API
    app.post('/add-products', async (req, res) => {
      try {
        const product = req.body;

        const imagesError = validateImages(product.images);
        if (imagesError) {
          return res.status(400).json({ error: imagesError });
        }

        const images = product.images.map((url) => url.trim());
        // Cover image
        const image = isValidUrl(product.image) ? product.image.trim() : images[0];

        const result = await productsCollection.insertOne({
          ...product,
          image,
          images,
          price: Number(product.price),
          stock: Number(product.stock),
        });
        res.status(201).json(result);
      } catch (error) {
        console.error("Error adding product:", error);
        res.status(500).json({ error: "Failed to add product" });
      }
    });


    //Get Products API
    app.get('/products', async (req, res) => {
      try {
        const products = await productsCollection.find().toArray();
        res.status(200).json(products);
      } catch (error) {
        console.error("Error fetching products:", error);
        res.status(500).json({ error: "Failed to fetch products" });
      }
    })

   //Products Details API
    app.get('/products/:id', async (req, res) => {
      try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ error: "Invalid product id" });
        }
        const result = await productsCollection.findOne({ _id: new ObjectId(id) });
        if (!result) {
          return res.status(404).json({ error: "Product not found" });
        }
        res.status(200).json(result);
      } catch (error) {
        console.error("Error fetching product:", error);
        res.status(500).json({ error: "Failed to fetch product" });
      }
    })

    //Update Product API
    app.patch('/products/:id', async (req, res) => {
      try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ error: "Invalid product id" });
        }
        if (!req.body || Object.keys(req.body).length === 0) {
          return res.status(400).json({ error: "No fields to update" });
        }

        const { _id, ...fields } = req.body;
        const updateDoc = {};

        if ('images' in fields) {
          const imagesError = validateImages(fields.images);
          if (imagesError) {
            return res.status(400).json({ error: imagesError });
          }
          const images = fields.images.map((url) => url.trim());
          updateDoc.images = images;
          if ('image' in fields && isValidUrl(fields.image)) {
            updateDoc.image = fields.image.trim();
          } else {
            updateDoc.image = images[0];
          }
        } else if ('image' in fields) {
          if (!isValidUrl(fields.image)) {
            return res.status(400).json({ error: "image must be a valid http(s) URL" });
          }
          updateDoc.image = fields.image.trim();
        }

        if ('price' in fields) {
          const price = Number(fields.price);
          if (Number.isNaN(price)) {
            return res.status(400).json({ error: "price must be a valid number" });
          }
          updateDoc.price = price;
        }

        if ('stock' in fields) {
          const stock = Number(fields.stock);
          if (Number.isNaN(stock)) {
            return res.status(400).json({ error: "stock must be a valid number" });
          }
          updateDoc.stock = stock;
        }

        for (const [key, value] of Object.entries(fields)) {
          if (['_id', 'image', 'images', 'price', 'stock'].includes(key)) continue;
          updateDoc[key] = value;
        }

        if (Object.keys(updateDoc).length === 0) {
          return res.status(400).json({ error: "No fields to update" });
        }
        updateDoc.updatedAt = new Date();

        const result = await productsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updateDoc }
        );
        if (result.matchedCount === 0) {
          return res.status(404).json({ error: "Product not found" });
        }

        const updated = await productsCollection.findOne({ _id: new ObjectId(id) });
        res.status(200).json(updated);
      } catch (error) {
        console.error("Error updating product:", error);
        res.status(500).json({ error: "Failed to update product" });
      }
    })

    //Delete Product API
    app.delete('/products/:id', async (req, res) => {
      try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ error: "Invalid product id" });
        }
        const result = await productsCollection.deleteOne({ _id: new ObjectId(id) });
        if (result.deletedCount === 0) {
          return res.status(404).json({ error: "Product not found" });
        }
        res.status(200).json({ success: true, deletedId: id, deletedCount: result.deletedCount });
      } catch (error) {
        console.error("Error deleting product:", error);
        res.status(500).json({ error: "Failed to delete product" });
      }
    })

    //Create Order API
    app.post('/orders', async (req, res) => {
      const { error, value } = validateOrder(req.body);
      if (error) {
        return res.status(400).json({ error });
      }

      try {
        const objectIds = value.items.map((item) => new ObjectId(item.productId));
        const products = await productsCollection
          .find({ _id: { $in: objectIds } })
          .toArray();
        const productById = new Map(products.map((p) => [p._id.toString(), p]));

        for (const item of value.items) {
          const product = productById.get(item.productId);
          if (!product) {
            return res.status(404).json({ error: `Product not found: ${item.productId}` });
          }
          const stock = Number(product.stock);
          if (!Number.isFinite(stock) || stock < item.quantity) {
            return res.status(400).json({ error: `Insufficient stock for product: ${item.productId}` });
          }
        }

        const orderItems = value.items.map((item) => {
          const product = productById.get(item.productId);
          const unitPrice = Number(product.price);
          return {
            productId: new ObjectId(item.productId),
            title: product.title || product.name || "",
            image: product.image || "",
            unitPrice,
            quantity: item.quantity,
            subtotal: unitPrice * item.quantity,
          };
        });

        const subtotal = orderItems.reduce((sum, item) => sum + item.subtotal, 0);
        const totalAmount = subtotal + value.deliveryCharge;
        const now = new Date();
        const orderDoc = {
          customer: value.customer,
          items: orderItems,
          itemCount: orderItems.reduce((sum, item) => sum + item.quantity, 0),
          subtotal,
          deliveryCharge: value.deliveryCharge,
          totalAmount,
          paymentMethod: "cod",
          // paymentStatus: "unpaid",
          orderStatus: "pending",
          note: value.note,
          createdAt: now,
          updatedAt: now,
        };

        const session = client.startSession();
        try {
          let insertedId = null;
          await session.withTransaction(async () => {
            const insertResult = await ordersCollection.insertOne(orderDoc, { session });
            insertedId = insertResult.insertedId;

            for (const item of value.items) {
              const stockResult = await productsCollection.updateOne(
                { _id: new ObjectId(item.productId), stock: { $gte: item.quantity } },
                { $inc: { stock: -item.quantity }, $set: { updatedAt: new Date() } },
                { session }
              );
              if (stockResult.matchedCount === 0) {
                throw new Error(`Insufficient stock for product: ${item.productId}`);
              }
            }
          });
          const order = await ordersCollection.findOne({ _id: insertedId });
          res.status(201).json(order);
        } finally {
          await session.endSession();
        }
      } catch (error) {
        if (error.message && error.message.startsWith("Insufficient stock")) {
          return res.status(400).json({ error: error.message });
        }
        console.error("Error creating order:", error);
        res.status(500).json({ error: "Failed to create order" });
      }
    });

    //Get Orders API
    app.get('/orders', async (req, res) => {
      try {
        const filter = {};
        if (req.query.phone) {
          filter["customer.phone"] = String(req.query.phone).trim();
        }
        const orders = await ordersCollection.find(filter).sort({ createdAt: -1 }).toArray();
        res.status(200).json(orders);
      } catch (error) {
        console.error("Error fetching orders:", error);
        res.status(500).json({ error: "Failed to fetch orders" });
      }
    });

    //Update Order API
    app.patch('/orders/:id', async (req, res) => {
      try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ error: "Invalid order id" });
        }
        const { error, value } = validateOrderPatch(req.body);
        if (error) {
          return res.status(400).json({ error });
        }

        const existing = await ordersCollection.findOne({ _id: new ObjectId(id) });
        if (!existing) {
          return res.status(404).json({ error: "Order not found" });
        }

        const isFinal = FINAL_ORDER_STATUSES.includes(existing.orderStatus);
        const wantsDataChange = ("customer" in value) || ("note" in value) || ("deliveryCharge" in value) || ("items" in value);
        if (isFinal && wantsDataChange) {
          return res.status(400).json({ error: `Order is ${existing.orderStatus} and cannot be edited` });
        }
        if (existing.orderStatus === "delivered" && value.orderStatus === "cancelled") {
          return res.status(400).json({ error: "Delivered order cannot be cancelled" });
        }

        const newStatus = value.orderStatus || existing.orderStatus;
        const newDeliveryCharge = ("deliveryCharge" in value) ? value.deliveryCharge : existing.deliveryCharge;
        const newCustomer = ("customer" in value) ? { ...existing.customer, ...value.customer } : existing.customer;
        const newNote = ("note" in value) ? value.note : (existing.note || "");

        //keep old unitPrice, new products use DB price
        let finalItems = existing.items;
        if ("items" in value) {
          const oldMap = new Map((existing.items || []).map((it) => [
            it.productId.toString(),
            { quantity: it.quantity, unitPrice: it.unitPrice, title: it.title, image: it.image },
          ]));
          const newIds = value.items.map((it) => new ObjectId(it.productId));
          const products = await productsCollection.find({ _id: { $in: newIds } }).toArray();
          const productById = new Map(products.map((p) => [p._id.toString(), p]));

          for (const it of value.items) {
            if (!oldMap.has(it.productId) && !productById.has(it.productId)) {
              return res.status(404).json({ error: `Product not found: ${it.productId}` });
            }
          }

          finalItems = value.items.map((it) => {
            if (oldMap.has(it.productId)) {
              const old = oldMap.get(it.productId);
              return {
                productId: new ObjectId(it.productId),
                title: old.title || "",
                image: old.image || "",
                unitPrice: old.unitPrice,
                quantity: it.quantity,
                subtotal: old.unitPrice * it.quantity,
              };
            }
            const product = productById.get(it.productId);
            const unitPrice = Number(product.price);
            return {
              productId: new ObjectId(it.productId),
              title: product.title || product.name || "",
              image: product.image || "",
              unitPrice,
              quantity: it.quantity,
              subtotal: unitPrice * it.quantity,
            };
          });
        }

        const subtotal = finalItems.reduce((sum, it) => sum + it.subtotal, 0);
        const itemCount = finalItems.reduce((sum, it) => sum + it.quantity, 0);
        const totalAmount = subtotal + newDeliveryCharge;

        // Stock adjustments
        const oldQty = new Map((existing.items || []).map((it) => [it.productId.toString(), it.quantity]));
        const newQty = new Map(finalItems.map((it) => [it.productId.toString(), it.quantity]));
        const isCancelling = existing.orderStatus !== "cancelled" && newStatus === "cancelled";
        const isReopening = existing.orderStatus === "cancelled" && newStatus !== "cancelled";

        const deltas = new Map();
        if ("items" in value && !isCancelling && !isReopening) {
          const allIds = new Set([...oldQty.keys(), ...newQty.keys()]);
          for (const pid of allIds) {
            const d = (newQty.get(pid) || 0) - (oldQty.get(pid) || 0);
            if (d !== 0) deltas.set(pid, d);
          }
        }

        const session = client.startSession();
        try {
          await session.withTransaction(async () => {
            if (!isCancelling) {
              const needCheck = isReopening
                ? [...newQty.entries()]
                : [...deltas.entries()].filter(([, d]) => d > 0).map(([pid, d]) => [pid, d]);
              for (const [pid, need] of needCheck) {
                const qtyNeeded = isReopening ? need : need;
                const prod = await productsCollection.findOne({ _id: new ObjectId(pid) }, { session });
                if (!prod) throw new Error(`Product not found: ${pid}`);
                if (!Number.isFinite(Number(prod.stock)) || Number(prod.stock) < qtyNeeded) {
                  throw new Error(`Insufficient stock for product: ${pid}`);
                }
              }
            }

            await ordersCollection.updateOne(
              { _id: new ObjectId(id) },
              {
                $set: {
                  customer: newCustomer,
                  items: finalItems,
                  itemCount,
                  subtotal,
                  deliveryCharge: newDeliveryCharge,
                  totalAmount,
                  orderStatus: newStatus,
                  note: newNote,
                  updatedAt: new Date(),
                },
              },
              { session }
            );

            if (isCancelling) {
              for (const [pid, qty] of oldQty.entries()) {
                await productsCollection.updateOne(
                  { _id: new ObjectId(pid) },
                  { $inc: { stock: qty }, $set: { updatedAt: new Date() } },
                  { session }
                );
              }
            } else if (isReopening) {
              for (const [pid, qty] of newQty.entries()) {
                const r = await productsCollection.updateOne(
                  { _id: new ObjectId(pid), stock: { $gte: qty } },
                  { $inc: { stock: -qty }, $set: { updatedAt: new Date() } },
                  { session }
                );
                if (r.matchedCount === 0) throw new Error(`Insufficient stock for product: ${pid}`);
              }
            } else {
              for (const [pid, d] of deltas.entries()) {
                if (d > 0) {
                  const r = await productsCollection.updateOne(
                    { _id: new ObjectId(pid), stock: { $gte: d } },
                    { $inc: { stock: -d }, $set: { updatedAt: new Date() } },
                    { session }
                  );
                  if (r.matchedCount === 0) throw new Error(`Insufficient stock for product: ${pid}`);
                } else {
                  await productsCollection.updateOne(
                    { _id: new ObjectId(pid) },
                    { $inc: { stock: -d }, $set: { updatedAt: new Date() } },
                    { session }
                  );
                }
              }
            }
          });

          const updated = await ordersCollection.findOne({ _id: new ObjectId(id) });
          res.status(200).json(updated);
        } finally {
          await session.endSession();
        }
      } catch (err) {
        if (err.message && (err.message.startsWith("Insufficient stock") || err.message.startsWith("Product not found"))) {
          const code = err.message.startsWith("Product not found") ? 404 : 400;
          return res.status(code).json({ error: err.message });
        }
        console.error("Error updating order:", err);
        res.status(500).json({ error: "Failed to update order" });
      }
    });

    //Order Details API
    app.get('/orders/:id', async (req, res) => {
      try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ error: "Invalid order id" });
        }
        const result = await ordersCollection.findOne({ _id: new ObjectId(id) });
        if (!result) {
          return res.status(404).json({ error: "Order not found" });
        }
        res.status(200).json(result);
      } catch (error) {
        console.error("Error fetching order:", error);
        res.status(500).json({ error: "Failed to fetch order" });
      }
    })


    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
    // await client.close();
  }
}
run().catch(console.dir);

app.get('/', (req, res) => {
  res.send('Hello World!');
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
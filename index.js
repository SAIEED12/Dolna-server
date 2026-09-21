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
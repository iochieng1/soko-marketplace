import { sql } from "drizzle-orm";

import { hashPassword } from "../auth/password.js";
import { loadConfig } from "../config.js";
import { createDb, type Database } from "./client.js";
import { inventory, products, sellers } from "./schema.js";

const sampleProducts = [
  {
    slug: "kikoy-beach-wrap",
    title: "Kikoy beach wrap",
    description: "Hand-woven cotton kikoy from Mombasa. 100 x 170 cm.",
    price: 1500,
    status: "ACTIVE",
    onHand: 25,
  },
  {
    slug: "maasai-shuka-blanket",
    title: "Maasai shuka blanket",
    description: "Classic red check shuka, warm acrylic weave.",
    price: 1200,
    status: "ACTIVE",
    onHand: 40,
  },
  {
    slug: "kenya-aa-coffee-500g",
    title: "Kenya AA coffee beans, 500 g",
    description: "Single-origin Nyeri AA, medium roast, whole bean.",
    price: 1800,
    status: "ACTIVE",
    onHand: 60,
  },
  {
    slug: "sisal-kiondo-basket",
    title: "Sisal kiondo basket",
    description: "Woven sisal basket with leather handles, made in Machakos.",
    price: 2500,
    status: "ACTIVE",
    onHand: 8,
  },
  {
    // Not public yet: must never appear in the storefront.
    slug: "soapstone-elephant-carving",
    title: "Soapstone elephant carving",
    description: "Kisii soapstone, hand carved and polished.",
    price: 3200,
    status: "DRAFT",
    onHand: 5,
  },
] as const;

// Local demo login for the seller dashboard. Never used outside dev.
export const DEMO_SELLER = {
  email: "duka@example.co.ke",
  password: "soko-demo-1234",
};

/** Inserts a demo seller with sample products. Safe to run repeatedly. */
export const seedDatabase = async (db: Database) => {
  const passwordHash = await hashPassword(DEMO_SELLER.password);
  await db.transaction(async (tx) => {
    const { email } = DEMO_SELLER;
    await tx
      .insert(sellers)
      .values({
        name: "Duka la Mama Wanjiku",
        email,
        phone: "254712345678",
        passwordHash,
      })
      .onConflictDoNothing();
    // Also (re)sets the password on a seller seeded before auth existed.
    await tx
      .update(sellers)
      .set({ passwordHash })
      .where(sql`lower(${sellers.email}) = ${email}`);
    const [seller] = await tx
      .select({ id: sellers.id })
      .from(sellers)
      .where(sql`lower(${sellers.email}) = ${email}`);
    if (!seller) throw new Error("Seed seller missing after insert");

    const inserted = await tx
      .insert(products)
      .values(
        sampleProducts.map((p) => ({
          sellerId: seller.id,
          slug: p.slug,
          title: p.title,
          description: p.description,
          price: p.price,
          status: p.status,
        })),
      )
      .onConflictDoNothing({ target: products.slug })
      .returning({ id: products.id, slug: products.slug });

    if (inserted.length > 0) {
      await tx.insert(inventory).values(
        inserted.map(({ id, slug }) => ({
          productId: id,
          onHand: sampleProducts.find((p) => p.slug === slug)?.onHand ?? 0,
        })),
      );
    }
  });

  return sampleProducts;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const { DATABASE_URL } = loadConfig();
  const { db, sql: client } = createDb(DATABASE_URL);
  try {
    await seedDatabase(db);
    console.log(`Seeded ${sampleProducts.length} sample products`);
    console.log(
      `Demo seller login: ${DEMO_SELLER.email} / ${DEMO_SELLER.password}`,
    );
  } finally {
    await client.end();
  }
}

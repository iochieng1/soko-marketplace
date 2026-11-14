import { hash, verify } from "@node-rs/argon2";

// OWASP's argon2id baseline: 19 MiB memory, 2 iterations, 1 lane. The
// parameters are stored in each hash, so raising them later only affects new
// hashes and old ones keep verifying.
const options = {
  // Algorithm.Argon2id. The package exports it as an ambient const enum,
  // which verbatimModuleSyntax can't import, so the value is inlined.
  algorithm: 2,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

export const hashPassword = (password: string) => hash(password, options);

/** False for a wrong password and for anything that isn't a valid hash. */
export const verifyPassword = async (
  passwordHash: string,
  password: string,
) => {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
};

// Login runs a real verify even when the email doesn't exist, so response
// time doesn't reveal which emails have accounts.
let dummyHash: Promise<string> | undefined;
export const burnPasswordCheck = async (password: string) => {
  dummyHash ??= hashPassword("timing-equaliser-not-a-real-password");
  await verifyPassword(await dummyHash, password);
};

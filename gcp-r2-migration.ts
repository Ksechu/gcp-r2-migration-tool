/*
 * Cloud Storage Migration Script: GCP to S3-Compatible Storage
 *
 * This script automates the process of migrating folders from Google Cloud Storage (GCP)
 * to an S3-compatible service like Cloudflare R2. It identifies folders updated after
 * a specific date and transfers them, preserving the original folder structure.
 *
 * --- HOW TO USE ---
 * 1. Fill in all the constant variables in the Configuration section below.
 * 2. Ensure your GCP and S3 credentials are set up correctly.
 * 3. Run the script via `npx ts-node gcp-r2-migration.ts`.
 */

import { Storage } from '@google-cloud/storage';
import { S3Client, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import pLimit from 'p-limit';

// -----------------------------------------------------------------------------------
// General Configuration
// -----------------------------------------------------------------------------------
const GCP_BUCKET_NAME = '[YOUR_GCP_BUCKET_NAME]';

// This is the internal directory path within your GCP bucket.
const GCP_INTERNAL_PATH = '[YOUR_GCP_INTERNAL_PATH]';

// This is the name of the file used to check the folder's creation/update date.
const FOLDER_DATE_CHECK_FILE = '[FOLDER_DATE]';

// The script will only migrate folders that were created on or after this date.
const MINIMUM_DATE = new Date('2025-03-10T00:00:00Z');

// This controls how many files are fetched from GCP in a single request.
const BATCH_SIZE = 1000;

// -----------------------------------------------------------------------------------
// S3 / Cloudflare R2 Configuration
// -----------------------------------------------------------------------------------
const S3_BUCKET_NAME = '[YOUR_S3_BUCKET_NAME]';
const S3_ACCESS_KEY_ID = '[YOUR_S3_ACCESS_KEY_ID]';
const S3_SECRET_ACCESS_KEY = '[YOUR_S3_SECRET_ACCESS_KEY]';
const S3_ACCOUNT_ID = '[YOUR_S3_ACCOUNT_ID]';

// The endpoint for your S3-compatible service (e.g., Cloudflare R2).
const S3_ENDPOINT = `https://${S3_ACCOUNT_ID}.r2.cloudflarestorage.com`;

// -----------------------------------------------------------------------------------
// Client Initialization
// -----------------------------------------------------------------------------------
const gcpStorage = new Storage();
const gcpBucket = gcpStorage.bucket(GCP_BUCKET_NAME);

const s3 = new S3Client({
  region: 'auto', // For Cloudflare R2, 'auto' is the recommended region
  endpoint: S3_ENDPOINT,
  credentials: {
    accessKeyId: S3_ACCESS_KEY_ID,
    secretAccessKey: S3_SECRET_ACCESS_KEY,
  },
});

// Controls the number of concurrent file uploads. Adjust based on your network and CPU.
const limit = pLimit(8);

async function findAndProcessRecentFolders(): Promise<void> {
  try {
    let pageToken: string | undefined;
    const recentFoldersFound: Set<string> = new Set<string>();
    let totalFilesCount = 0;
    let requestCount = 0;
    const allFoldersFoundInTotal: Set<string> = new Set<string>();

    console.log(`🔗 Getting file list from '${GCP_BUCKET_NAME}/${GCP_INTERNAL_PATH}'...`);
    console.log(`⏳ Searching for folders created after ${MINIMUM_DATE.toISOString()}`);

    // --- Step 1: Scan the GCP bucket to find folders created after the specified date ---
    do {
      requestCount++;
      const options: { prefix: string; maxResults: number; pageToken?: string } = {
        prefix: GCP_INTERNAL_PATH,
        maxResults: BATCH_SIZE,
      };

      if (pageToken) {
        options.pageToken = pageToken;
      }

      const [files, , apiResponse] = await gcpBucket.getFiles(options);

      if (files.length === 0) {
        if (!pageToken) {
          console.log('❌ No files or folders found at the specified path.');
        }
        break;
      }

      totalFilesCount += files.length;
      let recentFoundInBatch = 0;

      for (const file of files) {
        // Split the file path to get the folder name and file name.
        const pathParts = file.name.split('/');
        const folderName = pathParts[pathParts.length - 2];
        const fileName = pathParts[pathParts.length - 1];

        if (folderName && fileName) {
          allFoldersFoundInTotal.add(folderName);
        }

        // Check the file's creation date to see if it's a new folder.
        if (fileName === FOLDER_DATE_CHECK_FILE) {
          const fileCreationDate = new Date(file.metadata.timeCreated);
          if (fileCreationDate >= MINIMUM_DATE) {
            recentFoundInBatch++;
            recentFoldersFound.add(folderName);
          }
        }
      }

      console.log(
        `✅ Request #${requestCount}. Total files: ${totalFilesCount} (${allFoldersFoundInTotal.size} folders). ` +
        `Of which: ${recentFoundInBatch} are recent.`,
      );

      pageToken = (apiResponse as any).nextPageToken;
    } while (pageToken);

    const finalFolders = Array.from(recentFoldersFound);

    if (finalFolders.length === 0) {
      console.log('\n❌ No new folders with updated template.js files were found.');
    } else {
      console.log(`\n✅ Scanning complete. Found ${finalFolders.length} new unique folders.`);
      console.log('All new unique folders:', finalFolders);
    }

    // -----------------------------------------------------------------------------------
    // --- Step 2: Migrate the identified folders to S3 / Cloudflare R2 ---
    // -----------------------------------------------------------------------------------
    console.log('\n--- Starting S3 migration ---');

    let migratedFoldersCount = 0;
    const totalFoldersToMigrate = finalFolders.length;

    for (const folderName of finalFolders) {
      console.log(`\n➡️ Starting migration for folder: ${folderName}`);

      // 1. Get a list of all files in the R2 folder to find what's already there
      const r2Files: Set<string> = new Set();
      let r2ContinuationToken: string | undefined;

      do {
        const listParams = {
          Bucket: S3_BUCKET_NAME,
          Prefix: `${GCP_INTERNAL_PATH}${folderName}/`,
        };
        const listCommand = new ListObjectsV2Command(listParams);
        const listResponse = await s3.send(listCommand);

        if (listResponse.Contents) {
          listResponse.Contents.forEach(item => {
            if (item.Key) {
              r2Files.add(item.Key);
            }
          });
        }
        r2ContinuationToken = listResponse.NextContinuationToken;
      } while (r2ContinuationToken);

      console.log(`   ✅ Found ${r2Files.size} existing files in R2 for this folder.`);

      // 2. Get the list of all files in the GCP folder
      const [gcpFiles] = await gcpBucket.getFiles({ prefix: `${GCP_INTERNAL_PATH}${folderName}/` });

      // 3. Filter out files that already exist in R2
      const filesToMigrate = gcpFiles.filter(file => {
        return !r2Files.has(file.name);
      });

      console.log(`   📂 Found ${gcpFiles.length} files in GCP. Migrating ${filesToMigrate.length} new or updated files.`);

      if (filesToMigrate.length === 0) {
        console.log('   ⚠️ Folder is fully synced, no new files to transfer.');
        migratedFoldersCount++;
        const remainingFolders = totalFoldersToMigrate - migratedFoldersCount;
        console.log(`   ✨ Folders migrated: ${migratedFoldersCount}/${totalFoldersToMigrate} (Remaining: ${remainingFolders})`);
        continue;
      }

      // 4. Upload each missing file to S3
      let transferredCount = 0;
      const totalFilesToTransfer = filesToMigrate.length;

      const uploadPromises = filesToMigrate.map(file => {
        return limit(async () => {
          const s3Key = file.name;
          let fileBuffer;
          let downloadSuccess = false;

          // New Logic: Retry mechanism for file download
          for (let i = 0; i < 3; i++) { // Try up to 3 times
            try {
              [fileBuffer] = await file.download();

              // Explicitly check the downloaded buffer for integrity.
              if (!fileBuffer) {
                throw new Error('Downloaded buffer is null or undefined.');
              }
              downloadSuccess = true;
              break; // Success, exit retry loop
            } catch (e) {
              console.log(`   ⚠️ Retrying download for file: ${s3Key} (Attempt ${i + 1}/3)`);
              console.error('   ❌ Download failed with error:', e);
              await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
            }
          }

          if (!downloadSuccess) {
            console.error(`   ❌ CRITICAL: Failed to download file from GCP after 3 attempts. Skipping: ${s3Key}`);
            return; // Skip this file to prevent data loss
          }
          
          const bodyContent = (fileBuffer.length > 0) ? fileBuffer : Buffer.from('');
          const contentType = file.metadata.contentType || 'application/octet-stream';

          const uploadParams = {
            Bucket: S3_BUCKET_NAME,
            Key: s3Key,
            Body: bodyContent,
            ContentType: contentType,
          };

          await s3.send(new PutObjectCommand(uploadParams));

          transferredCount++;
          console.log(`   ✔️ File transferred (${transferredCount}/${totalFilesToTransfer}): ${s3Key}`);
        });
      });

      await Promise.all(uploadPromises);

      migratedFoldersCount++;
      const remainingFolders = totalFoldersToMigrate - migratedFoldersCount;
      console.log(`✅ Migration for folder '${folderName}' complete. All files are now in sync.`);
      console.log(`✨ Folders migrated: ${migratedFoldersCount}/${totalFoldersToMigrate} (Remaining: ${remainingFolders})`);
    }

    console.log('\n--- Migration process finished ---');
  } catch (error) {
    console.error('❌ An overall error occurred:', error);
  }
}

findAndProcessRecentFolders();

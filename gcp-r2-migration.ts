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

// -----------------------------------------------------------------------------------
// General Configuration
// -----------------------------------------------------------------------------------
const GCP_BUCKET_NAME = '[YOUR_GCP_BUCKET_NAME]';

// This is the internal directory path within your GCP bucket.
const GCP_INTERNAL_PATH = '[YOUR_GCP_INTERNAL_PATH]';

// This is the name of the file used to check the folder's creation/update date.
// If you want to migrate all folders, regardless of date, you can remove this constant
// and its related date-checking logic in the 'findAndProcessRecentFolders' function.
const FOLDER_DATE_CHECK_FILE = '[FOLDER_DATE]';

// The script will only migrate folders that were created on or after this date.
// Set to a past date (e.g., '2000-01-01T00:00:00Z') to migrate everything.
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

      // 1. Check if the folder already exists in S3 to prevent duplicate transfers.
      const listParams = {
        Bucket: S3_BUCKET_NAME,
        Prefix: `${GCP_INTERNAL_PATH}${folderName}/`,
        MaxKeys: 1,
      };
      const listCommand = new ListObjectsV2Command(listParams);
      const listResponse = await s3.send(listCommand);

      if (listResponse.Contents && listResponse.Contents.length > 0) {
        console.log(`   ❌ Folder '${folderName}' already exists in S3. Skipping.`);
        migratedFoldersCount++;
        const remainingFolders = totalFoldersToMigrate - migratedFoldersCount;
        console.log(`   ✨ Folders migrated: ${migratedFoldersCount}/${totalFoldersToMigrate} (Remaining: ${remainingFolders})`);
        continue;
      }

      console.log(`   ✅ Folder '${folderName}' not found in S3. Starting transfer...`);

      // 2. Get the list of all files in the folder from GCP.
      const [gcpFiles] = await gcpBucket.getFiles({ prefix: `${GCP_INTERNAL_PATH}${folderName}/` });
      console.log(`   📂 Found ${gcpFiles.length} files to transfer.`);

      if (gcpFiles.length === 0) {
        console.log('   ⚠️ Folder is empty, no transfer required.');
        migratedFoldersCount++;
        const remainingFolders = totalFoldersToMigrate - migratedFoldersCount;
        console.log(`   ✨ Folders migrated: ${migratedFoldersCount}/${totalFoldersToMigrate} (Remaining: ${remainingFolders})`);
        continue;
      }

      // 3. Upload each file to S3.
      let transferredCount = 0;
      const totalFiles = gcpFiles.length;

      for (const file of gcpFiles) {
        // Use the full file path from GCP as the S3 object key to preserve the folder structure.
        const s3Key = file.name;

        // Download the file into a buffer before uploading to S3 to avoid streaming issues.
        const fileBuffer = await file.download();

        const uploadParams = {
          Bucket: S3_BUCKET_NAME,
          Key: s3Key,
          Body: fileBuffer[0],
          ContentType: file.metadata.contentType,
        };

        await s3.send(new PutObjectCommand(uploadParams));

        transferredCount++;
        console.log(`   ✔️ File transferred (${transferredCount}/${totalFiles}): ${s3Key}`);
      }

      migratedFoldersCount++;
      const remainingFolders = totalFoldersToMigrate - migratedFoldersCount;
      console.log(`✅ Migration for folder '${folderName}' complete.`);
      console.log(`✨ Folders migrated: ${migratedFoldersCount}/${totalFoldersToMigrate} (Remaining: ${remainingFolders})`);
    }

    console.log('\n--- Migration process finished ---');
  } catch (error) {
    console.error('❌ An overall error occurred:', error);
  }
}

findAndProcessRecentFolders();

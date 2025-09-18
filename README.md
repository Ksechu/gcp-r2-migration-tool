### **GCP to Cloudflare R2 Migration Tool**

A versatile Node.js script to automate the migration of content from Google Cloud Storage (GCS) to a Cloudflare R2 bucket. This tool can be configured to either sync recently updated folders or perform a full, one-time migration of all assets within a specified prefix.

### **Features**

  * **Targeted Migration**: Migrates only folders updated after a specific date. This is ideal for continuous syncing workflows.
  * **Full Migration**: Easily disable the date filter to perform a complete, one-time transfer of all files within a specified GCP internal path.
  * **Idempotent Transfers**: The script checks if a folder already exists in R2 before a transfer, preventing redundant uploads and saving on API costs.
  * **Real-time Feedback**: Provides detailed console logs, including progress tracking for both individual files and the total number of folders migrated.
  * **Highly Configurable**: All cloud credentials, bucket names, and internal paths are managed as constants at the top of the file, making it easy to adapt the script for different projects.

### **Prerequisites**

Before running this script, ensure you have the following:

1.  **Node.js**: The latest LTS version is recommended.
2.  **GCP Service Account Key**: A JSON key file with permissions to list objects and read files from your specified GCS bucket. Set the `GOOGLE_APPLICATION_CREDENTIALS` environment variable to its path.
3.  **Cloudflare R2 API Tokens**: An Access Key ID and Secret Access Key with write permissions for your R2 bucket.
4.  **Dependencies**: Install the necessary Node.js packages by running the following command in your terminal:
    ```bash
    npm install @google-cloud/storage @aws-sdk/client-s3
    ```

-----

### **Configuration**

Open the `gcp-r2-migration.ts` file and update the following constants with your specific project details.

```typescript
// GCS Bucket & Internal Path
const GCP_BUCKET_NAME = '[YOUR_GCP_BUCKET_NAME]';
const GCP_INTERNAL_PATH = '[YOUR_GCP_INTERNAL_PATH]';

// R2 Bucket & Credentials
const S3_BUCKET_NAME = '[YOUR_S3_BUCKET_NAME]';
const S3_ACCESS_KEY_ID = '[YOUR_S3_ACCESS_KEY_ID]';
const S3_SECRET_ACCESS_KEY = '[YOUR_S3_SECRET_ACCESS_KEY]';
const S3_ACCOUNT_ID = '[YOUR_S3_ACCOUNT_ID]';
```

-----

### **How to Use**

**Targeted (Date-based) Migration**
This is the default mode. The script will only transfer folders that have been updated since the `MINIMUM_DATE`.

1.  Set the **MINIMUM\_DATE** constant to your desired start date.
2.  Run the script: `npx ts-node gcp-r2-migration.ts`.

**Full Migration**
If you want to migrate all folders within a specified `GCP_INTERNAL_PATH`, you can easily bypass the date-based filtering.

1.  Find the `FOLDER_DATE_CHECK_FILE` constant.
2.  In the `findAndProcessRecentFolders` function, replace the `if (pathParts.length === 3 && pathParts[2] === FOLDER_DATE_CHECK_FILE)` block with a simple `recentFoldersFound.add(folderName);` statement inside the `for (const file of files)` loop.

-----

### Troubleshooting

**404 Errors on a Public URL**: Ensure the R2 container's Public Access settings are configured correctly and a public access policy is set for the container.

**ERR_HTTP_INVALID_HEADER_VALUE**: This error is typically resolved by the current script's logic, which downloads the file's entire buffer before uploading. If the error persists, check your network connection or the file's integrity.

---

### TypeError: Cannot read properties of null (reading 'length')

This error occurs during a file download from GCP. It indicates a **compatibility issue** between your **Node.js** version and the **@google-cloud/storage** library, not a corrupted file. This bug can manifest **intermittently**, causing the script to work for some people and fail for others.

#### **Solution**

1.  **Update Your Script.** Make sure you are using the latest version of the script. It includes **retry logic** and safe buffer handling, which resolves the issue for most cases.

2.  **Check Your Node.js Version.** This error often appears on specific Node.js versions, such as certain builds of v18. Find your current version by running this command in your terminal:
    ```bash
    node -v
    ```

3.  **Switch to a Stable Version.** The most reliable solution is to switch to a recent Node.js LTS (Long-Term Support) version where this bug is confirmed to be fixed. We recommend using **Node.js v20**.

    -   Use **nvm** (Node Version Manager) for easy version switching.
        ```bash
        nvm install 20
        nvm use 20
        ```
    -   After switching to the new version, re-run your script.

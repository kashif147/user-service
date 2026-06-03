const {
  blobServiceClient,
  containerName,
  sharedKeyCredential,
  isConfigured,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
} = require("../config/azure.storage");

const DEFAULT_BRANDING_SAS_DAYS = 3650;

function brandingSasExpiryDays() {
  const raw = Number(process.env.AZURE_BRANDING_SAS_EXPIRY_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BRANDING_SAS_DAYS;
}

function getBlobReadSasUrl(blobPath, expiryDays = brandingSasExpiryDays()) {
  if (!isConfigured || !sharedKeyCredential || !blobPath) {
    return null;
  }
  const container = blobServiceClient.getContainerClient(containerName);
  const blobClient = container.getBlockBlobClient(blobPath);
  const startsOn = new Date();
  const expiresOn = new Date(
    startsOn.getTime() + expiryDays * 24 * 60 * 60 * 1000
  );
  const sas = generateBlobSASQueryParameters(
    {
      containerName,
      blobName: blobPath,
      permissions: BlobSASPermissions.parse("r"),
      startsOn,
      expiresOn,
    },
    sharedKeyCredential
  ).toString();
  return `${blobClient.url}?${sas}`;
}

async function uploadToBlob(blobPath, buffer, contentType, downloadFileName = null) {
  if (!isConfigured) {
    throw new Error(
      "Azure Storage is not configured. Set AZURE_STORAGE_CONNECTION_STRING or AZURE_STORAGE_ACCOUNT and AZURE_STORAGE_KEY."
    );
  }
  const nameForDisposition =
    downloadFileName || blobPath.split("/").pop() || "file";
  const asciiFallback = nameForDisposition
    .replace(/[\r\n"]/g, "_")
    .replace(/[^\x20-\x7E]/g, "_")
    .slice(0, 200) || "file";

  const container = blobServiceClient.getContainerClient(containerName);
  await container.createIfNotExists();
  const blockBlob = container.getBlockBlobClient(blobPath);
  await blockBlob.uploadData(buffer, {
    blobHTTPHeaders: {
      blobContentType: contentType || "application/octet-stream",
      blobContentDisposition: `inline; filename="${asciiFallback}"`,
    },
  });
  return getBlobReadSasUrl(blobPath) || blockBlob.url;
}

module.exports = {
  uploadToBlob,
  getBlobReadSasUrl,
  isConfigured,
};

import fs from 'fs';
import { Readable } from 'stream';
import { logger } from '@librechat/data-schemas';
import { FileSources } from 'librechat-data-provider';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import type { GetObjectCommandInput } from '@aws-sdk/client-s3';
import type { TFile } from 'librechat-data-provider';
import type { ServerRequest } from '~/types';
import type {
  UploadFileParams,
  SaveBufferParams,
  BatchUpdateFn,
  SaveURLParams,
  GetURLParams,
  UploadResult,
  S3FileRef,
} from '~/storage/types';
import { initializeS3 } from '~/cdn/s3';
import { deleteRagFile } from '~/files';
import { s3Config } from './s3Config';

const {
  AWS_BUCKET_NAME: bucketName,
  AWS_ENDPOINT_URL: endpoint,
  AWS_FORCE_PATH_STYLE: forcePathStyle,
  S3_URL_EXPIRY_SECONDS: s3UrlExpirySeconds,
  S3_REFRESH_EXPIRY_MS: s3RefreshExpiryMs,
  S3_USE_PUBLIC_URLS: usePublicUrls,
  DEFAULT_BASE_PATH: defaultBasePath,
} = s3Config;

export const getS3Key = (basePath: string, userId: string, fileName: string): string => {
  if (basePath.includes('/')) {
    throw new Error(`[getS3Key] basePath must not contain slashes: "${basePath}"`);
  }
  return `${basePath}/${userId}/${fileName}`;
};

export async function getS3URL({
  userId,
  fileName,
  basePath = defaultBasePath,
  customFilename = null,
  contentType = null,
}: GetURLParams): Promise<string> {
  const key = getS3Key(basePath, userId, fileName);
  const params: GetObjectCommandInput = { Bucket: bucketName, Key: key };

  if (customFilename) {
    const safeFilename = customFilename.replace(/["\r\n]/g, '');
    params.ResponseContentDisposition = `attachment; filename="${safeFilename}"`;
  }
  if (contentType) {
    params.ResponseContentType = contentType;
  }
  
  if (usePublicUrls && endpoint) {
    const baseUrl = endpoint.endsWith('/') ? endpoint.slice(0, -1) : endpoint;
    return `${baseUrl}/${bucketName}/${key}`;
  }

  try {
    const s3 = initializeS3();
    if (!s3) {
      throw new Error('[getS3URL] S3 not initialized');
    }

    return await getSignedUrl(s3, new GetObjectCommand(params), { expiresIn: s3UrlExpirySeconds });
  } catch (error) {
    logger.error('[getS3URL] Error getting signed URL from S3:', (error as Error).message);
    throw error;
  }
}

/**
 * Gets a fresh signed URL for a given S3 key.
 * @param {string} key - The S3 key to sign.
 * @returns {Promise<string>} The fresh signed URL.
 */
export async function getS3URLByKey(key: string): Promise<string> {
  if (usePublicUrls && endpoint) {
    const baseUrl = endpoint.endsWith('/') ? endpoint.slice(0, -1) : endpoint;
    return `${baseUrl}/${bucketName}/${key}`;
  }

  const params: GetObjectCommandInput = { Bucket: bucketName, Key: key };

  try {
    const s3 = initializeS3();
    if (!s3) {
      throw new Error('[getS3URLByKey] S3 not initialized');
    }

    return await getSignedUrl(s3, new GetObjectCommand(params), { expiresIn: s3UrlExpirySeconds });
  } catch (error) {
    logger.error('[getS3URLByKey] Error getting signed URL from S3:', (error as Error).message);
    throw error;
  }
}

export async function saveBufferToS3({
  userId,
  buffer,
  fileName,
  basePath = defaultBasePath,
}: SaveBufferParams): Promise<string> {
  const key = getS3Key(basePath, userId, fileName);
  const params = {
    Bucket: bucketName,
    Key: key,
    Body: buffer,
    ContentLength: buffer.length,
  };

  try {
    const s3 = initializeS3();
    if (!s3) {
      throw new Error('[saveBufferToS3] S3 not initialized');
    }

    await s3.send(new PutObjectCommand(params));
    return await getS3URL({ userId, fileName, basePath });
  } catch (error) {
    logger.error('[saveBufferToS3] Error uploading buffer to S3:', (error as Error).message);
    throw error;
  }
}

export async function saveURLToS3({
  userId,
  URL,
  fileName,
  basePath = defaultBasePath,
}: SaveURLParams): Promise<string> {
  try {
    const response = await fetch(URL);
    if (!response.ok) {
      throw new Error(`Failed to fetch URL: ${response.status} ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    return await saveBufferToS3({ userId, buffer, fileName, basePath });
  } catch (error) {
    logger.error('[saveURLToS3] Error uploading file from URL to S3:', (error as Error).message);
    throw error;
  }
}

export function extractKeyFromS3Url(fileUrlOrKey: string): string {
  if (!fileUrlOrKey) {
    throw new Error('Invalid input: URL or key is empty');
  }

  try {
    const url = new URL(fileUrlOrKey);
    const hostname = url.hostname;
    const pathname = url.pathname.substring(1);

    // 1. Check if the bucket name is in the hostname (Virtual-host style)
    if (bucketName && hostname.startsWith(`${bucketName}.`)) {
      logger.debug(`[extractKeyFromS3Url] Virtual-host style detected. Key: ${pathname}`);
      return pathname;
    }

    // 2. Check if the bucket name is the first part of the path (Path-style)
    if (bucketName && pathname.startsWith(`${bucketName}/`)) {
      const key = pathname.substring(bucketName.length + 1);
      logger.debug(`[extractKeyFromS3Url] Path-style detected. Key: ${key}`);
      return key;
    }

    // 3. Fallback for custom endpoints or other S3-compatible services
    if (endpoint && forcePathStyle) {
      try {
        const endpointUrl = new URL(endpoint);
        const prefix = endpointUrl.pathname.endsWith('/')
          ? endpointUrl.pathname
          : `${endpointUrl.pathname}/`;
        if (url.pathname.startsWith(`${prefix}${bucketName}/`)) {
          const key = url.pathname.substring(`${prefix}${bucketName}/`.length);
          return key;
        }
      } catch (e) {
        // ignore parsing error
      }
    }

    logger.debug(`[extractKeyFromS3Url] Defaulting to pathname. Key: ${pathname}`);
    return pathname;
  } catch (error) {
    if (fileUrlOrKey.startsWith('http://') || fileUrlOrKey.startsWith('https://')) {
      logger.error(
        `[extractKeyFromS3Url] Error parsing URL: ${fileUrlOrKey}, Error: ${(error as Error).message}`,
      );
    } else {
      logger.debug(`[extractKeyFromS3Url] Non-URL input, using fallback: ${fileUrlOrKey}`);
    }

    const parts = fileUrlOrKey.split('/');
    if (parts.length >= 3 && !fileUrlOrKey.startsWith('http') && !fileUrlOrKey.startsWith('/')) {
      return fileUrlOrKey;
    }

    const key = fileUrlOrKey.startsWith('/') ? fileUrlOrKey.substring(1) : fileUrlOrKey;
    logger.debug(
      `[extractKeyFromS3Url] FALLBACK. fileUrlOrKey: ${fileUrlOrKey}, Extracted key: ${key}`,
    );
    return key;
  }
}

export async function deleteFileFromS3(req: ServerRequest, file: TFile): Promise<void> {
  if (!req.user) {
    throw new Error('[deleteFileFromS3] User not authenticated');
  }

  const userId = req.user.id;
  const key = extractKeyFromS3Url(file.filepath);

  const keyParts = key.split('/');
  if (keyParts.length < 2 || keyParts[1] !== userId) {
    const message = `[deleteFileFromS3] User ID mismatch: ${userId} vs ${key}`;
    logger.error(message);
    throw new Error(message);
  }

  const s3 = initializeS3();
  if (!s3) {
    throw new Error('[deleteFileFromS3] S3 not initialized');
  }

  const params = { Bucket: bucketName, Key: key };

  try {
    try {
      const headCommand = new HeadObjectCommand(params);
      await s3.send(headCommand);
      logger.debug('[deleteFileFromS3] File exists, proceeding with deletion');
    } catch (headErr) {
      if ((headErr as { name?: string }).name === 'NotFound') {
        logger.warn(`[deleteFileFromS3] File does not exist: ${key}`);
        await deleteRagFile({ userId, file });
        return;
      }
      throw headErr;
    }

    await s3.send(new DeleteObjectCommand(params));
    await deleteRagFile({ userId, file });
    logger.debug('[deleteFileFromS3] S3 File deletion completed');
  } catch (error) {
    logger.error(`[deleteFileFromS3] Error deleting file from S3: ${(error as Error).message}`);
    logger.error((error as Error).stack);

    if ((error as { name?: string }).name === 'NoSuchKey') {
      return;
    }
    throw error;
  }
}

export async function uploadFileToS3({
  req,
  file,
  file_id,
  basePath = defaultBasePath,
}: UploadFileParams): Promise<UploadResult> {
  if (!req.user) {
    throw new Error('[uploadFileToS3] User not authenticated');
  }

  try {
    const inputFilePath = file.path;
    const userId = req.user.id;
    const fileName = `${file_id}__${file.originalname}`;
    const key = getS3Key(basePath, userId, fileName);

    const stats = await fs.promises.stat(inputFilePath);
    const bytes = stats.size;
    const buffer = await fs.promises.readFile(inputFilePath);

    const s3 = initializeS3();
    if (!s3) {
      throw new Error('[uploadFileToS3] S3 not initialized');
    }

    const uploadParams = {
      Bucket: bucketName,
      Key: key,
      Body: buffer,
      ContentType: file.mimetype,
      ContentLength: bytes,
    };

    await s3.send(new PutObjectCommand(uploadParams));
    const fileURL = await getS3URL({ userId, fileName, basePath });
    return { filepath: fileURL, bytes };
  } catch (error) {
    logger.error('[uploadFileToS3] Error streaming file to S3:', error);
    if (file?.path) {
      await fs.promises
        .unlink(file.path)
        .catch((e: unknown) =>
          logger.error('[uploadFileToS3] Failed to delete temp file:', (e as Error).message),
        );
    }
    throw error;
  }
}

export async function getS3FileStream(_req: ServerRequest, filePath: string): Promise<Readable> {
  try {
    const Key = extractKeyFromS3Url(filePath);
    const params = { Bucket: bucketName, Key };

    const s3 = initializeS3();
    if (!s3) {
      throw new Error('[getS3FileStream] S3 not initialized');
    }

    const data = await s3.send(new GetObjectCommand(params));
    if (!data.Body) {
      throw new Error(`[getS3FileStream] S3 response body is empty for key: ${Key}`);
    }
    return data.Body as Readable;
  } catch (error) {
    logger.error('[getS3FileStream] Error retrieving S3 file stream:', error);
    throw error;
  }
}

export function needsRefresh(signedUrl: string, bufferSeconds: number): boolean {
  try {
    const url = new URL(signedUrl);

    if (!url.searchParams.has('X-Amz-Signature')) {
      return false;
    }

    if (usePublicUrls) {
      return true;
    }

    const expiresParam = url.searchParams.get('X-Amz-Expires');
    const dateParam = url.searchParams.get('X-Amz-Date');

    if (!expiresParam || !dateParam) {
      return true;
    }

    const year = dateParam.substring(0, 4);
    const month = dateParam.substring(4, 6);
    const day = dateParam.substring(6, 8);
    const hour = dateParam.substring(9, 11);
    const minute = dateParam.substring(11, 13);
    const second = dateParam.substring(13, 15);

    const dateObj = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
    const now = new Date();

    if (s3RefreshExpiryMs !== null) {
      const urlAge = now.getTime() - dateObj.getTime();
      return urlAge >= s3RefreshExpiryMs;
    }

    const expiresAtDate = new Date(dateObj.getTime() + parseInt(expiresParam) * 1000);
    const bufferTime = new Date(now.getTime() + bufferSeconds * 1000);
    return expiresAtDate <= bufferTime;
  } catch (error) {
    logger.error('Error checking URL expiration:', error);
    return true;
  }
}

export async function getNewS3URL(currentURL: string): Promise<string | undefined> {
  try {
    const s3Key = extractKeyFromS3Url(currentURL);
    if (!s3Key) {
      return;
    }

    return getS3URLByKey(s3Key);
  } catch (error) {
    logger.error('[getNewS3URL] Error getting fresh S3 URL:', (error as Error).message);
    return undefined;
  }
}

export async function refreshS3FileUrls(
  files: TFile[] | null | undefined,
  batchUpdateFiles: BatchUpdateFn,
  bufferSeconds = 3600,
): Promise<TFile[]> {
  if (!files || !Array.isArray(files) || files.length === 0) {
    return [];
  }

  const filesToUpdate: Array<{ file_id: string; filepath: string }> = [];
  const updatedFiles = [...files];

  for (let i = 0; i < updatedFiles.length; i++) {
    const file = updatedFiles[i];
    if (!file?.file_id) {
      continue;
    }
    if (file.source !== FileSources.s3) {
      continue;
    }
    if (!file.filepath) {
      continue;
    }

    try {
      let s3Key = extractKeyFromS3Url(file.filepath);
      
      // 1. SELF-HEALING: Detect and fix corrupted or truncated paths
      const expectedPrefix = `images/${file.user}/`;
      const fileId = file.file_id;
      const isCorrupted = s3Key && (!s3Key.startsWith(expectedPrefix) || s3Key.includes(`/${file.user}/${file.user.substring(9)}/`));

      if (isCorrupted) {
        const fileIdIndex = s3Key.indexOf(fileId);
        if (fileIdIndex !== -1) {
          const partFromFileId = s3Key.substring(fileIdIndex);
          const correctedKey = `${expectedPrefix}${partFromFileId}`;
          logger.info(`[HEALER] Repairing path for file ${fileId}. Old: ${s3Key}, New: ${correctedKey}`);
          s3Key = correctedKey;
        } else {
          logger.warn(`[HEALER] Could not find fileId ${fileId} in s3Key ${s3Key}. Skipping repair.`);
        }
      }

      // 2. Skip if it's already a healthy Public URL
      if (usePublicUrls && file.filepath.includes(bucketName) && !file.filepath.includes('X-Amz-Signature') && !isCorrupted) {
        continue;
      }

      // 3. Skip if it's a healthy signed URL that doesn't need refresh yet
      if (!isCorrupted && !needsRefresh(file.filepath, bufferSeconds)) {
        continue;
      }

      const newURL = await getS3URLByKey(s3Key);
      if (!newURL || newURL === file.filepath) {
        continue;
      }
      filesToUpdate.push({
        file_id: file.file_id,
        filepath: newURL,
      });
      updatedFiles[i] = { ...file, filepath: newURL };
    } catch (error) {
      logger.error(`Error refreshing S3 URL for file ${file.file_id}:`, error);
    }
  }

  if (filesToUpdate.length > 0) {
    await batchUpdateFiles(filesToUpdate);
  }

  return updatedFiles;
}

export async function refreshS3Url(fileObj: S3FileRef, bufferSeconds = 3600): Promise<string> {
  if (!fileObj || fileObj.source !== FileSources.s3 || !fileObj.filepath) {
    return fileObj?.filepath || '';
  }

  if (!needsRefresh(fileObj.filepath, bufferSeconds)) {
    return fileObj.filepath;
  }

  try {
    const s3Key = extractKeyFromS3Url(fileObj.filepath);
    if (!s3Key) {
      logger.warn(`Unable to extract S3 key from URL: ${fileObj.filepath}`);
      return fileObj.filepath;
    }

    const keyParts = s3Key.split('/');
    if (keyParts.length < 3) {
      logger.warn(`Invalid S3 key format: ${s3Key}`);
      return fileObj.filepath;
    }

    const basePath = keyParts[0];
    const userId = keyParts[1];
    const fileName = keyParts.slice(2).join('/');

    const newUrl = await getS3URL({ userId, fileName, basePath });
    logger.debug(`Refreshed S3 URL for key: ${s3Key}`);
    return newUrl;
  } catch (error) {
    logger.error(`Error refreshing S3 URL: ${(error as Error).message}`);
    return fileObj.filepath;
  }
}

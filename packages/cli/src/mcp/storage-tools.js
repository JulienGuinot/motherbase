'use strict';

// Storage configuration over MCP, the counterpart of Supabase's
// get_storage_config / update_storage_config. Motherbase keeps that
// configuration in three settings groups plus the S3 endpoint, so these two
// tools fold them back into the single view an agent expects.

const api = require('../api');

/** Setting group -> the tool argument that edits each of its fields. */
const WRITABLE = {
  'storage.limits': { maxUploadBytes: 'maxUploadBytes', allowedMimeTypes: 'allowedMimeTypes' },
  'storage.imageTransform': { enabled: 'imageTransformEnabled', maxSourceBytes: 'imageTransformMaxSourceBytes' },
  'storage.policies': { enabled: 'policiesEnabled' },
};

/** Groups the arguments touch, each with the field values to change. */
function changesByGroup(args) {
  const changes = {};
  for (const [group, fields] of Object.entries(WRITABLE)) {
    for (const [field, argName] of Object.entries(fields)) {
      if (args[argName] === undefined) continue;
      const value = Array.isArray(args[argName]) ? args[argName].join(', ') : args[argName];
      (changes[group] ||= {})[field] = value;
    }
  }
  return changes;
}

const valuesOf = group => (group && group.values) || {};

function readStorageTools(ctx) {
  return [
    {
      name: 'get_storage_config',
      description:
        'Storage configuration: the global upload size limit and allowed MIME types, image transformations, whether PostgreSQL policies authorize storage access, and the S3 protocol endpoint. Per-bucket limits are on list_storage_buckets.',
      inputSchema: { type: 'object', properties: {} },
      run: async () => {
        const [limits, imageTransform, policies, s3] = await Promise.all([
          api.adminRequest(ctx, 'GET', '/settings/storage.limits'),
          api.adminRequest(ctx, 'GET', '/settings/storage.imageTransform'),
          api.adminRequest(ctx, 'GET', '/settings/storage.policies'),
          api.adminRequest(ctx, 'GET', '/storage/s3'),
        ]);
        return {
          limits: valuesOf(limits),
          imageTransform: valuesOf(imageTransform),
          policies: valuesOf(policies),
          s3,
        };
      },
    },
  ];
}

function writeStorageTools(ctx) {
  return [
    {
      name: 'update_storage_config',
      description:
        'Change the global storage configuration. Only the fields you pass change. Per-bucket size limits and MIME types are edited on the bucket itself.',
      inputSchema: {
        type: 'object',
        properties: {
          maxUploadBytes: { type: 'integer', minimum: 0, description: 'Largest upload in bytes. 0 uses the server default.' },
          allowedMimeTypes: {
            type: 'array',
            items: { type: 'string' },
            description: 'Allowed MIME types, wildcards like image/* supported. Empty allows everything.',
          },
          imageTransformEnabled: { type: 'boolean', description: 'Serve resized images from /storage/v1/render/image.' },
          imageTransformMaxSourceBytes: { type: 'integer', minimum: 1, description: 'Largest image, in bytes, that will be transformed.' },
          policiesEnabled: { type: 'boolean', description: 'Authorize storage access with RLS policies on storage.files.' },
        },
      },
      run: async args => {
        const changes = changesByGroup(args);
        if (!Object.keys(changes).length) throw new Error('Pass at least one field to change.');
        // The settings API replaces a group wholesale, so an untouched field
        // would fall back to its default unless it is sent back as it is.
        const saved = {};
        for (const [group, fields] of Object.entries(changes)) {
          const current = valuesOf(await api.adminRequest(ctx, 'GET', `/settings/${group}`));
          saved[group] = await api.adminRequest(ctx, 'PUT', `/settings/${group}`, { body: { ...current, ...fields } });
        }
        return saved;
      },
    },
  ];
}

module.exports = { readStorageTools, writeStorageTools, changesByGroup };

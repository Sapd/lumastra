// SPDX-License-Identifier: Apache-2.0
/**
 * Sample: defineExternalService — settings/credentials only, no behaviour.
 * Deliberately declares NO contract method: that absence is what makes it an
 * external service rather than something misclassified.
 *
 * @type {import('@sapd/lumastra-plugin-sdk').ExternalServiceDefinition}
 */
export default {
    id: 'sample-external-service',
    name: 'Sample External Service',
    version: '1.0.0',
    settings: { fields: [{ key: 'apiKey', type: 'secret', label: 'API key' }] },
};

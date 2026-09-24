targetScope = 'resourceGroup'

@description('Azure region supporting Speech. Personal Voice requires separate approval and regional availability.')
param location string = resourceGroup().location

@description('Unique Speech resource name, also used as its irreversible custom subdomain. Use lowercase letters, digits, and internal hyphens.')
@minLength(2)
@maxLength(64)
param speechName string = 'voicesynth-${uniqueString(subscription().id, resourceGroup().id)}'

@description('Microsoft Entra object ID of the user who will run az login. Not an email, application ID, or subscription ID.')
@minLength(36)
@maxLength(36)
param userObjectId string

@description('User for synthesis; Contributor for managing Personal Voice projects and recordings. Neither grants feature approval.')
@allowed([
  'User'
  'Contributor'
])
param speechRole string = 'User'

var roleDefinitionGuid = speechRole == 'Contributor'
  ? '0e75ca1e-0464-4b4d-8b93-68208a576181'
  : 'f2dc8367-1007-4938-bd23-fe263f013447'

resource speech 'Microsoft.CognitiveServices/accounts@2025-06-01' = {
  name: speechName
  location: location
  kind: 'SpeechServices'
  sku: {
    name: 'S0'
  }
  properties: {
    customSubDomainName: speechName
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: 'Allow'
    }
  }
}

resource speechUserRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(speech.id, userObjectId, roleDefinitionGuid)
  scope: speech
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleDefinitionGuid)
    principalId: userObjectId
    principalType: 'User'
  }
}

@description('Set AZURE_SPEECH_RESOURCE_ID to this value.')
output resourceId string = speech.id

@description('Set AZURE_SPEECH_REGION to this value.')
output region string = speech.location

@description('Set AZURE_SPEECH_ENDPOINT to this value for Personal Voice. No keys are output.')
output endpoint string = speech.properties.endpoint

output assignedRole string = 'Cognitive Services Speech ${speechRole}'

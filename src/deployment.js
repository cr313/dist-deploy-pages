const core = require('@actions/core')

// All variables we need from the runtime are loaded here
const getContext = require('./context')
const {
  getSignedArtifactUrl
} = require('./api-client')

const errorStatus = {
  unknown_status: 'Unable to get deployment status.',
  not_found: 'Deployment not found.',
  deployment_attempt_error: 'Deployment temporarily failed, a retry will be automatically scheduled...'
}

class Deployment {
  constructor() {
    const context = getContext()
    this.runTimeUrl = context.runTimeUrl
    this.repositoryNwo = context.repositoryNwo
    this.runTimeToken = context.runTimeToken
    this.buildVersion = context.buildVersion
    this.buildActor = context.buildActor
    this.actionsId = context.actionsId
    this.githubToken = context.githubToken
    this.workflowRun = context.workflowRun
    this.deploymentInfo = null
    this.githubApiUrl = context.githubApiUrl
    this.githubServerUrl = context.githubServerUrl
    this.artifactName = context.artifactName
    this.isPreview = context.isPreview === true
  }

  // Ask the runtime for the unsigned artifact URL and deploy to GitHub Pages
  // by creating a deployment with that artifact
  async create(idToken) {
    try {
      core.info(`Actor: ${this.buildActor}`)
      core.info(`Action ID: ${this.actionsId}`)
      core.info(`Actions Workflow Run ID: ${this.workflowRun}`)
      const pagesDeployEndpoint = `${this.githubApiUrl}/repos/${this.repositoryNwo}/pages/deployment`

      const artifactUrl = await getSignedArtifactUrl({
        runtimeToken: this.runTimeToken,
        workflowRunId: this.workflowRun,
        artifactName: this.artifactName
      })

      const deployment = await createPagesDeployment({
        githubToken: this.githubToken,
        artifactUrl,
        buildVersion: this.buildVersion,
        idToken,
        isPreview: this.isPreview
      })
      this.deploymentInfo = {
        ...deployment,
        id: deployment?.['status_url']?.split('/')?.pop() || this.buildVersion,
        pending: true
      }

      core.info(`Created deployment for ${this.buildVersion}, ID: ${this.deploymentInfo.id}`)
      core.info(JSON.stringify(deployment))

      return deployment
    } catch (error) {
      core.error(error.stack)

      // output raw error in debug mode.
      core.debug(JSON.stringify(error))

      // build customized error message based on server response
      if (error.response) {
        let errorMessage = `Failed to create deployment (status: ${error.response.status}) with build version ${this.buildVersion}. `
        if (error.response.status == 400) {
          let message = ''
          if (error.response.data && error.response.data.message) {
            message = error.response.data.message
          } else {
            message = error.response.data
          }
          errorMessage += `Responded with: ${message}`
        } else if (error.response.status == 403) {
          errorMessage += 'Ensure GITHUB_TOKEN has permission "pages: write".'
        } else if (error.response.status == 404) {
          const pagesSettingsUrl = `${this.githubServerUrl}/${this.repositoryNwo}/settings/pages`
          errorMessage += `Ensure GitHub Pages has been enabled: ${pagesSettingsUrl}`
        } else if (error.response.status >= 500) {
          errorMessage += 'Server error, is githubstatus.com reporting a Pages outage? Please re-run the deployment at a later time.'
        }
        throw new Error(errorMessage)
      } else {
        throw error
      }
    }
  }

  // Poll the deployment endpoint for status
  async check() {
    const deploymentId = this.deploymentInfo?.id || this.buildVersion
    const timeout = Number(core.getInput('timeout'))
    const reportingInterval = Number(core.getInput('reporting_interval'))
    const maxErrorCount = Number(core.getInput('error_count'))

    let startTime = Date.now()
    let errorCount = 0

    // Time in milliseconds between two deployment status report when status errored, default 0.
    let errorReportingInterval = 0

    try {

      /*eslint no-constant-condition: ["error", { "checkLoops": false }]*/
      while (true) {
        // Handle reporting interval
        await new Promise(resolve => setTimeout(resolve, reportingInterval + errorReportingInterval))

        // Check status
        let res = await getPagesDeploymentStatus({
          githubToken: this.githubToken,
          deploymentId
        })

        if (res.data.status === 'succeed') {
          core.info('Reported success!')
          core.setOutput('status', 'succeed')
          if (this.deploymentInfo) { this.deploymentInfo.pending = false }
          break
        } else if (res.data.status === 'deployment_failed') {
          // Fall into permanent error, it may be caused by ongoing incident or malicious deployment content or exhausted automatic retry times.
          core.setFailed('Deployment failed, try again later.')
          if (this.deploymentInfo) { this.deploymentInfo.pending = false }
          break
        } else if (res.data.status === 'deployment_content_failed') {
          // The uploaded artifact is invalid.
          core.setFailed(
            'Artifact could not be deployed. Please ensure the content does not contain any hard links, symlinks and total size is less than 10GB.'
          )
          if (this.deploymentInfo) { this.deploymentInfo.pending = false }
          break
        } else if (errorStatus[res.data.status]) {
          // A temporary error happened, will query the status again
          core.warning(errorStatus[res.data.status])
        } else {
          core.info('Current status: ' + res.data.status)
        }

        if (res.status !== 200 || !!errorStatus[res.data.status]) {
          errorCount++

          // set the maximum error reporting interval greater than 15 sec but below 30 sec.
          if (errorReportingInterval < 1000 * 15) {
            errorReportingInterval = (errorReportingInterval << 1) | 1
          }
        } else {
          // reset the error reporting interval once get the proper status back.
          errorReportingInterval = 0
        }

        if (errorCount >= maxErrorCount) {
          core.error('Too many errors, aborting!')
          core.setFailed('Failed with status code: ' + res.status)

          // Explicitly cancel the deployment
          await this.cancel()
          return
        }

        // Handle timeout
        if (Date.now() - startTime >= timeout) {
          core.error('Timeout reached, aborting!')
          core.setFailed('Timeout reached, aborting!')

          // Explicitly cancel the deployment
          await this.cancel()
          return
        }
      }
    } catch (error) {
      core.setFailed(error)
      if (error.response?.data) {
        core.error(JSON.stringify(error.response.data))
      }
    }
  }

  async cancel() {
    // Don't attempt to cancel if no deployment was created
    if (!this.deploymentInfo?.pending) {
      return
    }

    // Cancel the deployment
    try {
      const deploymentId = this.deploymentInfo?.id || this.buildVersion
      await cancelPagesDeployment({
        githubToken: this.githubToken,
        deploymentId
      })
      core.info(`Canceled deployment with ID ${deploymentId}`)

      if (this.deploymentInfo) {
        this.deploymentInfo.pending = false
      }
    } catch (error) {
      core.setFailed(error)
      if (error.response?.data) {
        core.error(JSON.stringify(error.response.data))
      }
    }
  }
}
module.exports = { Deployment }

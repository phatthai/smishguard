/*
 * SmishGuard CI/CD pipeline
 *
 *   Build -> Test -> Code Quality -> Security -> Deploy (staging) -> Release (production) -> Monitoring
 *
 * Every stage is a gate: a failure stops the pipeline before anything reaches production,
 * and a failed deployment or release rolls the environment back automatically.
 *
 * The pipeline runs on Windows or Linux agents. Each step calls a cross-platform tool
 * (npm, docker) or a dependency-free Node.js script in scripts/ci, through runCmd(),
 * which chooses `bat` or `sh` for the agent.
 *
 * Jenkins credentials (Manage Jenkins > Credentials), referenced by ID only:
 *   SONAR_TOKEN             Secret text        SonarCloud user token
 *   github-ghcr             Username/password  GitHub username + classic PAT (scopes: repo, write:packages)
 *   jwt-secret-staging      Secret text        32+ random characters
 *   jwt-secret-production   Secret text        32+ random characters (different from staging)
 *   discord-webhook         Secret text        Discord channel webhook URL (alerts + build notifications)
 *   grafana-admin-password  Secret text        Grafana admin password
 */

def runCmd(String command) {
    env.LAST_STAGE = env.STAGE_NAME ?: env.LAST_STAGE
    if (isUnix()) {
        sh command
    } else {
        bat command
    }
}

def runStatus(String command) {
    return isUnix() ? sh(script: command, returnStatus: true) : bat(script: command, returnStatus: true)
}

def capture(String command) {
    // On Windows the leading @ stops cmd from echoing the command into the captured output.
    return isUnix() ? sh(script: command, returnStdout: true).trim() : bat(script: "@${command}", returnStdout: true).trim()
}

def notifyTeam(String status) {
    try {
        withCredentials([string(credentialsId: 'discord-webhook', variable: 'DISCORD_WEBHOOK_URL')]) {
            def duration = currentBuild.durationString.replace(' and counting', '')
            runStatus("node scripts/ci/notify.js --status ${status} --stage \"${env.LAST_STAGE ?: 'n/a'}\" --duration \"${duration}\"")
        }
    } catch (err) {
        echo "Build notification skipped: ${err.message}"
    }
}

pipeline {
    agent any

    options {
        buildDiscarder(logRotator(numToKeepStr: '30', artifactNumToKeepStr: '10'))
        timestamps()
        timeout(time: 60, unit: 'MINUTES')
        disableConcurrentBuilds()
        skipStagesAfterUnstable()
    }

    triggers {
        // Jenkins runs on a local machine that GitHub webhooks cannot reach, so it polls
        // the repository every two minutes and builds each new commit automatically.
        pollSCM('H/2 * * * *')
    }

    parameters {
        choice(
            name: 'SIMULATE_INCIDENT',
            choices: ['none', 'outage', 'login-attack', 'scam-surge'],
            description: 'Monitoring stage: after the release, run an incident drill to prove detection and alerting work end to end.'
        )
    }

    environment {
        IMAGE_REPO  = 'ghcr.io/phatthai/smishguard'
        STAGING_URL = 'http://localhost:3001'
        PROD_URL    = 'http://localhost:3000'
        CI          = 'true'
        npm_config_update_notifier = 'false'
    }

    stages {
        // 1. BUILD: versioned, reproducible Docker image stored in GitHub Container Registry.
        stage('Build') {
            steps {
                script {
                    runCmd 'node scripts/ci/prepare.js'
                    env.APP_VERSION = capture('node scripts/ci/version.js')
                    env.BUILD_DATE = capture('node scripts/ci/version.js --date')
                    env.GIT_SHORT = env.GIT_COMMIT.substring(0, 7)
                    env.IMAGE = "${env.IMAGE_REPO}:${env.APP_VERSION}"
                    currentBuild.displayName = "#${env.BUILD_NUMBER} v${env.APP_VERSION}"
                    currentBuild.description = "commit ${env.GIT_SHORT}"

                    runCmd 'npm ci --no-audit --no-fund'
                    runCmd "docker build --pull --build-arg APP_VERSION=${env.APP_VERSION} --build-arg GIT_COMMIT=${env.GIT_COMMIT} --build-arg BUILD_DATE=${env.BUILD_DATE} -t ${env.IMAGE} -t ${env.IMAGE_REPO}:sha-${env.GIT_SHORT} ."
                }
                withCredentials([usernamePassword(credentialsId: 'github-ghcr', usernameVariable: 'GITHUB_USER', passwordVariable: 'GITHUB_TOKEN')]) {
                    script {
                        runCmd "node scripts/ci/registry.js push --image ${env.IMAGE} --also sha-${env.GIT_SHORT}"
                    }
                }
            }
            post {
                success {
                    archiveArtifacts artifacts: 'reports/registry.json', fingerprint: true
                }
            }
        }

        // 2. TEST: unit + integration tests with a coverage gate, in parallel with a smoke
        //    test of the built container itself.
        stage('Test') {
            parallel {
                stage('Unit & integration tests') {
                    steps {
                        script {
                            runCmd 'npm run test:ci'
                        }
                    }
                }
                stage('Container smoke test') {
                    steps {
                        script {
                            runCmd "node scripts/ci/container-test.js --image ${env.IMAGE} --version ${env.APP_VERSION}"
                        }
                    }
                }
            }
            post {
                always {
                    junit testResults: 'reports/junit/unit-integration.xml, reports/junit/container-smoke.xml', allowEmptyResults: true
                    script {
                        try {
                            recordCoverage(
                                tools: [[parser: 'COBERTURA', pattern: 'coverage/cobertura-coverage.xml']],
                                id: 'coverage', name: 'Jest coverage', sourceCodeRetention: 'EVERY_BUILD',
                                qualityGates: [
                                    [threshold: 90.0, metric: 'LINE', baseline: 'PROJECT', criticality: 'UNSTABLE'],
                                    [threshold: 80.0, metric: 'BRANCH', baseline: 'PROJECT', criticality: 'UNSTABLE']
                                ]
                            )
                        } catch (NoSuchMethodError ignored) {
                            echo 'Coverage plugin not installed: skipping the coverage trend chart'
                        }
                    }
                }
            }
        }

        // 3. CODE QUALITY: ESLint thresholds, SonarCloud analysis + quality gate, and a
        //    custom quality policy with trend reporting (policies/quality-policy.json).
        stage('Code Quality') {
            environment {
                SONAR_TOKEN = credentials('SONAR_TOKEN')
            }
            steps {
                script {
                    runCmd 'npm run lint:ci'
                    def scannerExit = runStatus("node node_modules/@sonar/scan/bin/sonar-scanner.js -Dsonar.projectVersion=${env.APP_VERSION}")
                    runCmd "node scripts/ci/sonar-gate.js --scanner-exit ${scannerExit}"
                }
            }
        }

        // 4. SECURITY: dependency audit, SAST, secret + IaC scanning and image scanning in
        //    parallel, then one policy gate (policies/security-policy.json).
        stage('Security') {
            stages {
                stage('Scan') {
                    parallel {
                        stage('SCA: npm audit') {
                            steps {
                                script {
                                    runCmd 'node scripts/ci/security-scan.js npm-audit'
                                }
                            }
                        }
                        stage('SAST: Semgrep') {
                            steps {
                                script {
                                    runCmd 'node scripts/ci/security-scan.js semgrep'
                                }
                            }
                        }
                        stage('Trivy: secrets, IaC, image, SBOM') {
                            steps {
                                script {
                                    runCmd "node scripts/ci/security-scan.js trivy --image ${env.IMAGE}"
                                }
                            }
                        }
                    }
                }
                stage('Security gate') {
                    steps {
                        script {
                            runCmd 'node scripts/ci/security-gate.js'
                        }
                    }
                }
            }
        }

        // 5. DEPLOY: staging via Docker Compose (infrastructure as code), verified by version
        //    and readiness, then end-to-end tests. Automatic rollback on failure.
        stage('Deploy') {
            environment {
                JWT_SECRET = credentials('jwt-secret-staging')
            }
            steps {
                script {
                    runCmd "node scripts/ci/deploy.js --env staging --image ${env.IMAGE}"
                    withEnv(["BASE_URL=${env.STAGING_URL}", "EXPECTED_VERSION=${env.APP_VERSION}", 'E2E_ENV=staging', 'E2E_MODE=full']) {
                        runCmd 'npm run test:e2e'
                    }
                }
            }
            post {
                always {
                    junit testResults: 'reports/junit/e2e-staging.xml', allowEmptyResults: true
                }
                failure {
                    script {
                        runStatus('node scripts/ci/deploy.js --env staging --rollback')
                    }
                }
            }
        }

        // 6. RELEASE: promote the exact image tested in staging to production with its own
        //    config and secrets, smoke-test it, tag it in the registry and on GitHub.
        //    If any step fails, production is rolled back to the last release.
        stage('Release') {
            environment {
                JWT_SECRET = credentials('jwt-secret-production')
            }
            steps {
                script {
                    runCmd "node scripts/ci/deploy.js --env production --image ${env.IMAGE}"
                    withEnv(["BASE_URL=${env.PROD_URL}", "EXPECTED_VERSION=${env.APP_VERSION}", 'E2E_ENV=production', 'E2E_MODE=smoke']) {
                        runCmd 'npm run test:e2e'
                    }
                }
                withCredentials([usernamePassword(credentialsId: 'github-ghcr', usernameVariable: 'GITHUB_USER', passwordVariable: 'GITHUB_TOKEN')]) {
                    script {
                        runCmd "node scripts/ci/registry.js promote --image ${env.IMAGE} --tag production"
                        runCmd 'node scripts/ci/github-release.js'
                    }
                }
            }
            post {
                always {
                    junit testResults: 'reports/junit/e2e-production.xml', allowEmptyResults: true
                }
                failure {
                    script {
                        runStatus('node scripts/ci/deploy.js --env production --rollback')
                    }
                }
            }
        }

        // 7. MONITORING: Prometheus, Alertmanager, Blackbox and Grafana as code; verify the
        //    new release is scraped and healthy, mark it on the dashboards, optional drill.
        stage('Monitoring') {
            environment {
                DISCORD_WEBHOOK_URL = credentials('discord-webhook')
                GRAFANA_ADMIN_PASSWORD = credentials('grafana-admin-password')
            }
            steps {
                script {
                    runCmd 'node scripts/ci/monitoring.js up'
                    runCmd "node scripts/ci/monitoring.js verify --expect-version ${env.APP_VERSION}"
                    runCmd "node scripts/ci/monitoring.js annotate --text \"Released v${env.APP_VERSION} to production (build #${env.BUILD_NUMBER}, commit ${env.GIT_SHORT})\" --tags deploy,production,v${env.APP_VERSION}"
                    if (params.SIMULATE_INCIDENT && params.SIMULATE_INCIDENT != 'none') {
                        runCmd "node scripts/ci/simulate-incident.js --scenario ${params.SIMULATE_INCIDENT}"
                    }
                }
            }
        }
    }

    post {
        always {
            archiveArtifacts artifacts: 'reports/**, coverage/cobertura-coverage.xml, coverage/lcov.info', allowEmptyArchive: true
            script {
                runStatus("node scripts/ci/cleanup.js --repo ${env.IMAGE_REPO} --keep 5")
            }
        }
        success {
            script {
                notifyTeam('SUCCESS')
            }
        }
        unstable {
            script {
                notifyTeam('UNSTABLE')
            }
        }
        failure {
            script {
                notifyTeam('FAILURE')
            }
        }
    }
}

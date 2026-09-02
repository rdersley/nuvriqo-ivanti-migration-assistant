$ErrorActionPreference = 'Stop'

Write-Host 'Installing Forge backend dependencies...'
npm install --registry=https://registry.npmjs.org/

Write-Host 'Installing frontend dependencies...'
npm --prefix static install --registry=https://registry.npmjs.org/

Write-Host 'Building frontend...'
npm run build

if (-not (Test-Path '.\static\dist\index.html')) {
    throw 'Build did not create static\dist\index.html.'
}

Write-Host 'Running Forge lint...'
forge lint

Write-Host 'Deploying to Forge development environment...'
forge deploy

Write-Host 'Upgrading Jira installation...'
forge install --upgrade

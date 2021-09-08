#!/usr/bin/env node
import 'source-map-support/register';
import cdk = require('@aws-cdk/core');
import { ServiceBackendStack } from '../lib/service_backend-stack';
import { Vars } from '../resources/vars';

const app = new cdk.App();
new ServiceBackendStack(app, Vars.stacks.dev.name, {env: Vars.stacks.dev.env});
new ServiceBackendStack(app, Vars.stacks.prod.name, {env: Vars.stacks.prod.env});


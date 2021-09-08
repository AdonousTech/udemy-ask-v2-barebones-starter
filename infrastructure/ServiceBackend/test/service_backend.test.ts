import { expect as expectCDK, matchTemplate, MatchStyle } from '@aws-cdk/assert';
import cdk = require('@aws-cdk/core');
import ServiceBackend = require('../lib/service_backend-stack');

test('Empty Stack', () => {
    const app = new cdk.App();
    // WHEN
    const stack = new ServiceBackend.ServiceBackendStack(app, 'MyTestStack');
    // THEN
    expectCDK(stack).to(matchTemplate({
      "Resources": {}
    }, MatchStyle.EXACT))
});
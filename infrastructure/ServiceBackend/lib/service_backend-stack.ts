import cdk = require('@aws-cdk/core');
import lambda = require('@aws-cdk/aws-lambda');
import iam = require('@aws-cdk/aws-iam');
import logs = require('@aws-cdk/aws-logs');
import cloudwatch = require('@aws-cdk/aws-cloudwatch');
import cloudwatchActions = require('@aws-cdk/aws-cloudwatch-actions');
import sns = require('@aws-cdk/aws-sns');
import s3 = require('@aws-cdk/aws-s3');
import cloudfront = require('@aws-cdk/aws-cloudfront');
import dynamodb = require('@aws-cdk/aws-dynamodb');
import path = require('path');

import { Duration } from '@aws-cdk/core';
import { EmailSubscription } from '@aws-cdk/aws-sns-subscriptions';
import { LogGroup } from '@aws-cdk/aws-logs';
import { ServicePrincipal, 
         PolicyStatement,
         CanonicalUserPrincipal } from '@aws-cdk/aws-iam';
import { SnsAction } from '@aws-cdk/aws-cloudwatch-actions';
import { Unit } from '@aws-cdk/aws-cloudwatch';
import { Bucket, 
         BucketAccessControl, 
         BlockPublicAccess,
         BucketEncryption } from '@aws-cdk/aws-s3';
import { OriginAccessIdentity, 
         CloudFrontWebDistribution, 
         CloudFrontAllowedMethods,
         HttpVersion,
         ViewerProtocolPolicy,
         PriceClass } from '@aws-cdk/aws-cloudfront';     

import { Vars } from '../resources/vars';
import { AttributeType, BillingMode, TableEncryption } from '@aws-cdk/aws-dynamodb';


export class ServiceBackendStack extends cdk.Stack {

  alarm: cloudwatch.Alarm;
  alarmTopic: sns.Topic;
  alarmTopicAction: cloudwatchActions.SnsAction;
  metric: cloudwatch.Metric;
  logGroup: logs.LogGroup;
  lambdaFunction: lambda.Function;
  executionRole: iam.Role;
  standardPolicy: iam.Policy;
  alexaLambdaPermission: lambda.CfnPermission;
  alexaLambdaPermissionSmartHome: lambda.CfnPermission;
  dbTable: dynamodb.Table;

  // CDN
  cdnBucket: s3.Bucket;
  OAI: cloudfront.OriginAccessIdentity;
  distro: CloudFrontWebDistribution;
  cdnBucketPolicy: iam.Policy;

  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
      
      //**Permissions */
      // define the lambda execution role
      this.executionRole = new iam.Role(this, 'ExecutionRole', {
        assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      });

      // define the policy statements for the execution role
      const stmtAllowLogs = new PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "logs:*"
        ],
        resources: [
          "arn:aws:logs:*:*:*"
        ]
      });

      const stmtXRayTracing = new PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "xray:PutTraceSegments",
          "xray:PutTelemetryRecords",
          "xray:GetSamplingRules",
          "xray:GetSamplingTargets",
          "xray:GetSamplingStatisticSummaries"
        ],
        resources: [
          "*"
        ]
      });

      const stmtAllowLambdaInvocations = new PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "lambda:InvokeFunction"
        ],
        resources: [
          "*"
        ]
      });
      
      // instantiate the execution policy and attach the statements
      this.standardPolicy = new iam.Policy(this, 'Policy', {
        statements: [
          stmtAllowLogs,
          stmtXRayTracing,
          stmtAllowLambdaInvocations
        ]
      });  
      
      // attach the policy to the execution role
      this.executionRole.attachInlinePolicy(this.standardPolicy);


      //**Function */
      // define the lambda function
      this.lambdaFunction = new lambda.Function(this, Vars.lambda.functionName, {
        runtime: lambda.Runtime.NODEJS_12_X,
        handler: 'index.handler',
        tracing: lambda.Tracing.ACTIVE,
        role: this.executionRole,
        timeout: Duration.seconds(30),
        memorySize: 128,
        code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/code/skill_lambda.zip')), 
        environment: {
          dbtable: props?.env?.account === Vars.stacks.prod.env.account
          ? Vars.stacks.prod.resources.dbtable
          : Vars.stacks.dev.resources.dbtable
        }
      });

      this.logGroup = new LogGroup(this, 'LogGroup', {
        logGroupName: '/aws/lambda/' + this.lambdaFunction.functionName
      })

      // Alexa Lambda Permissions
      this.alexaLambdaPermission = new lambda.CfnPermission(this, 'AlexaLambdaPermission', {
        action: 'lambda:invokeFunction',
        functionName: this.lambdaFunction.functionName,
        principal: 'alexa-appkit.amazon.com',
/*         eventSourceToken: '' */ //TODO: Update with skillId
      });

      this.alexaLambdaPermissionSmartHome = new lambda.CfnPermission(this, 'AlexaLambdaPermissionSmartHome', {
        action: 'lambda:invokeFunction',
        functionName: this.lambdaFunction.functionName,
        principal: 'alexa-connectedhome.amazon.com',
/*         eventSourceToken: '' */ //TODO: Update with skillId
      });

      // CDN source bucket
      this.cdnBucket = new Bucket(this, 'CDNSourceBucket', {
        accessControl: BucketAccessControl.PRIVATE,
        blockPublicAccess: new BlockPublicAccess( {
          blockPublicAcls: true,
          blockPublicPolicy: true,
          ignorePublicAcls: true,
          restrictPublicBuckets: true
        }),
        encryption: BucketEncryption.S3_MANAGED,
        websiteIndexDocument: "index.html",
        websiteErrorDocument: "error.html"
      });

      // OAI
      this.OAI = new OriginAccessIdentity(this, 'OAI', {
        comment: 'OAI for CDN static bucket'
      });

      // Bucket policy
      const stmtAllowOAIBucketAccess = new PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "s3:GetObject",
          "s3:ListBucket"
        ],
        resources: [
          this.cdnBucket.bucketArn
        ],
        principals: [
          new CanonicalUserPrincipal(this.OAI.cloudFrontOriginAccessIdentityS3CanonicalUserId)
        ]        
      });

      //CDN Web Distribution
      this.distro = new CloudFrontWebDistribution(this, 'CDNWebDistribution', {
        originConfigs: [
          {
            behaviors: [
              {
                allowedMethods: CloudFrontAllowedMethods.GET_HEAD_OPTIONS,
                compress: true,
                forwardedValues: {
                  headers: [ "Origin" ],
                  cookies: {
                    forward: "none"
                  },
                  queryString: false
                },
                isDefaultBehavior: true
              }
            ],
            s3OriginSource: {
              s3BucketSource: this.cdnBucket,
              originAccessIdentity: this.OAI
            }
          }
        ],
        defaultRootObject: "index.html",
        httpVersion: HttpVersion.HTTP2,
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        priceClass: PriceClass.PRICE_CLASS_ALL,
        errorConfigurations: [
          {
            errorCachingMinTtl: 0,
            errorCode: 500
          }
        ]
      });

      // DynamoDB Table
      this.dbTable = new dynamodb.Table(this, 'DBTable', {
        partitionKey: {name: 'id', type: AttributeType.STRING},
        encryption: TableEncryption.DEFAULT,
        billingMode: BillingMode.PAY_PER_REQUEST
      });

      //**Monitoring */
      // With custom metrics set the unit to none. If value is provided for unit OR dimensions,
      // alarm will be stuck in INSUFFICIENT state
      // Also need to treat missing data as not breaching as lambda function invocations are intermittent
      // See (for units and dimensions issue) https://medium.com/@martatatiana/insufficient-data-cloudwatch-alarm-based-on-custom-metric-filter-4e41c1f82050
      this.metric = new cloudwatch.Metric({
        metricName: Vars.lambda.functionName + '_CriticalErrors',
        namespace: Vars.lambda.functionName,
        period: Duration.seconds(60),
        statistic: 'Sum',
        unit: Unit.NONE
      })

      // SNS alarm Topic
      this.alarmTopic = new sns.Topic(this, 'AlarmTopic', {
        displayName: Vars.lambda.functionName + '_CriticalErrorNotif',
        topicName: Vars.lambda.functionName + '_CriticalErrorAlarmTopic'
      });

      // subscribe to Topic
      this.alarmTopic.addSubscription(new EmailSubscription(Vars.emailNotificationAddress, {json: true}));

      // Setting evaluation period and data points to alarm to same values 
      // see https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/AlarmThatSendsEmail.html
      this.alarm = new cloudwatch.Alarm(this, 'Alarm', {
        actionsEnabled: true,
        alarmDescription: 'Alarm triggered when predefined critical errors are triggered in the lambda function.',
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD, 
        datapointsToAlarm: 1,
        evaluationPeriods: 1,
        metric: this.metric,
        statistic: 'Sum',
        threshold: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
      });

      // bind the alarm to action
      this.alarmTopicAction = new SnsAction(this.alarmTopic);
      this.alarmTopicAction.bind(this, this.alarm);
      this.alarm.addAlarmAction(this.alarmTopicAction);

      // create the metric filter
      // See https://github.com/aws/aws-cdk/issues/3838 
      let metricFilter: logs.MetricFilter;
      metricFilter = new logs.MetricFilter(this, 'MetricFilter', {
        filterPattern: {logPatternString: '{ $.eventType = "CriticalError" }'},
        logGroup: this.logGroup,
        metricNamespace: this.metric.namespace,
        metricName: this.metric.metricName,
        defaultValue: 0,
        metricValue: '1'
      });

  }
}

import { Module } from '@nestjs/common';
import { SignaturesModule } from '../signatures/signatures.module';
import { SecurityPolicyController } from './security-policy.controller';
import { SecurityPolicyService } from './security-policy.service';

@Module({
  imports: [SignaturesModule],
  controllers: [SecurityPolicyController],
  providers: [SecurityPolicyService],
  exports: [SecurityPolicyService],
})
export class SecurityConfigModule {}

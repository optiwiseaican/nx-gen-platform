import { Module } from '@nestjs/common';
import { SignatureService } from './signature.service';
import { SignaturesController } from './signatures.controller';

@Module({
  controllers: [SignaturesController],
  providers: [SignatureService],
  exports: [SignatureService],
})
export class SignaturesModule {}

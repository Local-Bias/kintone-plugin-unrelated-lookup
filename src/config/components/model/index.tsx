import React, { FC, FCX } from 'react';
import { useRecoilValue } from 'recoil';
import styled from '@emotion/styled';

import { storageState } from '../../states/plugin';
import ConditionAdditionButton from '../functional/condition-addition-button';
import Condition from './accordion';
import { ConditionIndexProvider } from '../functional/condition-index-provider';

type Props = Readonly<{
  conditionLength: number;
}>;

const Component: FCX<Props> = ({ className, conditionLength }) => (
  <div {...{ className }}>
    {new Array(conditionLength).fill('').map((_, index) => (
      <ConditionIndexProvider key={index} conditionIndex={index}>
        <Condition key={index} />
      </ConditionIndexProvider>
    ))}
    <ConditionAdditionButton />
  </div>
);

const StyledComponent = styled(Component)`
  width: 100%;

  & > div {
    padding: 1em;
  }
`;

const Container: FC = () => {
  const storage = useRecoilValue(storageState);

  const conditionLength = storage?.conditions?.length ?? 1;

  return <StyledComponent conditionLength={conditionLength} />;
};

export default Container;

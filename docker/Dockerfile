FROM node:10
ARG JENKINS_GROUP_ID=200
ARG JENKINS_USER_ID=200

RUN groupadd --gid $JENKINS_GROUP_ID jenkins && \
    useradd --uid $JENKINS_USER_ID --gid $JENKINS_GROUP_ID --create-home jenkins

WORKDIR /mailDispatcher
